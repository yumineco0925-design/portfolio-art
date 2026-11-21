// main.js — 一秒の検定所の天秤。
// 計算は second_core に任せる。ここが持つのは形と光と、計算の状態から姿勢を決める所だけ。
// 梁の傾きは balance.js の createBalance().at(τ).theta を毎コマ時刻から求める（コマ番号は使わない）。

import * as THREE from '../vendor/three/three.module.min.js';
import { createStation, balance as BAL, gum as GUM, decide as DEC } from '../core/second_core/index.js';
import * as TX from './tex.js';

const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const qnum = (k) => {
  const v = Q.get(k);
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------- URL の状態 ----------
// d  持ち込んだ長さ（ms）。あれば、その長さを1回キーボードで押した票を作る
// t  離してから何秒後の姿か（既定 60 で止まり切った姿）
// view  基準の向きからのずれ「横,縦」（度）
// dpr  描く密度（撮影用。既定は端末の値で上限 2）
const URL_D = qnum('d');
const URL_T = qnum('t') ?? 60;
const URL_VIEW = (Q.get('view') ?? '').split(',').map(Number);
const DPR = qnum('dpr') ?? Math.min(window.devicePixelRatio || 1, 2);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- 寸法（mm）。天板の上面を y = 0、天秤の台の中心を x = z = 0 とする ----------
const PIV = 399;          // 中央のナイフエッジの刃先の高さ
const ARM = 115;          // 支点から両端のナイフエッジの刃先まで
const LIFT = 0.8;         // 止めたときに梁を持ち上げる量
const PLATE = { x: 305, z: 262, s: 0.66 }; // 窓口番号の札の置き場所と縮尺
const WALL_Z = -900;      // 奥の仕切りの面。検査灯の光が弱まるまで機構から離す
const RIDER_Y = 442;      // ライダーの送り棒の高さ
const ENV_K = 1.8; // 周りの映り込みの強さ
// 検査灯。天秤の左前上。梁への光がケースの前の上の枠に遮られない高さに置く
const KEY = { pos: [-300, 700, 420], aim: [0, 300, 0], power: 2.4e6, angle: 0.55, pen: 0.7 };
const BEAM_DROP = 15;     // 梁の止めを外したときに横木が下がる量
const PAN_DROP = 30;      // 皿の止めを外したときに柱が下がる量
const PAN_BOTTOM = -231;  // 端の刃先から皿の底の外側まで
const BASE_TOP = 78;
// 目盛り板。r0〜r1 の扇形、z は板の表。R は刻みと数字の半径（刻みの根元・長・中・短・数字・公差の帯）
const SCALE = {
  r0: 255, r1: 281, halfDeg: 13, z: 13,
  R: { base: 260, long: 269.5, mid: 267, short: 264.5, num: 273.6, band: [260, 261.8], labelDeg: 12 },
  screwR: 263, screwDeg: 12,
};
const POINTER_TIP = 258.5; // 指針の先の半径。刻みの根元の手前で止める
const ENGAGE_S = 0.3;     // 押すと、この時間で止めがかかる
const RELEASE_S = 0.35;   // 票が出ると、この時間で止めが外れ、そこから揺れ始める
const SETTLE_TOL = 5e-4;  // これより小さく揺れが収まったら目標の傾きで止めて描くのをやめる（rad）

const DEG = Math.PI / 180;
const CFG = BAL.DEFAULTS;
const TOL = DEC.DEFAULT_TOLERANCE;
// 零点付近で、指針の 1 目盛り（梁の 1°）に当たる差。balance.js の targetAngle の傾きから出す
const MS_PER_DIV = CFG.saturationMs / ((CFG.targetFraction * CFG.thetaMaxRad) / DEG);
// 公差の両端（1.000 s ± 0.050 s）で梁が止まる傾き（°）
const BAND_DEG = BAL.targetAngle(TOL.halfWidthMs) / DEG;

// ---------- 画面の文字 ----------
const button = $('#hold');
const modeBtn = $('#mode');
const out = $('#result');
const tolText = `${GUM.roundToDecimals(TOL.nominalMs / 1000, 3).text} s ± ${GUM.roundToDecimals(TOL.halfWidthMs / 1000, 3).text} s`;
$('#tol').innerHTML = `本日の公差　<b>${tolText}</b>（${TOL.grade}）`;

// 結果は1行目が判定、2行目が合格証（出たときだけ）。有効の長さは decide.js の値をそのまま出す
const VALIDITY_TEXT = `${GUM.roundToDecimals(DEC.CERTIFICATE_VALIDITY_MS / 1000, 3).text} s`;
function ticketRows(t, expired) {
  const head = t.n > 1 ? `${t.n} 回の平均　` : '';
  const rows = [`${head}${t.result.display.line}　${t.decision.label}`];
  if (t.decision.certificate) rows.push(`合格証　有効期間 ${VALIDITY_TEXT}${expired ? '　失効' : ''}`);
  return rows;
}
// 行ごとに折り返しを分ける。狭い幅で行の中を折るときは全角の空白の所でだけ折る
function showRows(rows, idle = false) {
  out.replaceChildren();
  for (const text of rows) {
    const row = document.createElement('span');
    row.className = 'row';
    text.split('　').forEach((seg, i) => {
      if (i) row.append('　');
      const sp = document.createElement('span');
      sp.className = 'seg';
      sp.textContent = seg;
      row.append(sp);
    });
    out.append(row);
  }
  out.classList.toggle('idle', idle);
}

let renderer = null;
let raf = 0;
let frame = () => {};

// ---------- 姿勢の状態 ----------
// a: 止めの度合い（1 で梁と皿を持ち上げて止めている、0 で放している）
// 梁の傾き θ = θ_free(τ) × (1 − a)。θ_free は票の値で作った天秤の閉じた形の解
const motion = { aFrom: 1, aTo: 1, aT0: 0, aDur: 0, bal: null, tRel: 0, target: 0, settleS: 0 };
let frozen = URL_D !== null;
const clock = () => (frozen ? URL_T : performance.now() / 1000);
const smooth = (u) => u * u * (3 - 2 * u);

function arrestAt(t) {
  if (motion.aDur <= 0) return motion.aTo;
  const u = Math.min(1, Math.max(0, (t - motion.aT0) / motion.aDur));
  return motion.aFrom + (motion.aTo - motion.aFrom) * smooth(u);
}
function freeAt(t) {
  if (!motion.bal) return { theta: 0, settled: true };
  if (REDUCED) return { theta: motion.target, settled: true };
  const tau = t - motion.tRel - RELEASE_S;
  if (tau <= 0) return { theta: 0, settled: false };
  if (tau >= motion.settleS) return { theta: motion.target, settled: true };
  return { theta: motion.bal.at(tau).theta, settled: false };
}
function stateAt(t) {
  const a = arrestAt(t);
  const f = freeAt(t);
  const arrestMoving = motion.aDur > 0 && t < motion.aT0 + motion.aDur;
  return { a, theta: f.theta * (1 - a), moving: arrestMoving || !f.settled };
}
function unfreeze() {
  if (!frozen) return;
  const shift = performance.now() / 1000 - URL_T;
  motion.aT0 += shift;
  motion.tRel += shift;
  frozen = false;
}
function engage() {
  unfreeze();
  const t = clock();
  const a = arrestAt(t);
  Object.assign(motion, { aFrom: a, aTo: 1, aT0: t, aDur: REDUCED ? 0 : ENGAGE_S * (1 - a) });
  requestRender();
}
function release(estimateMs, t) {
  const bal = BAL.createBalance();
  const { target } = bal.set(estimateMs - TOL.nominalMs, 0);
  const settleS = BAL.settleTime(-target, 0, bal.omega0, CFG.zeta, SETTLE_TOL);
  const a = arrestAt(t);
  Object.assign(motion, { bal, target, settleS, tRel: t, aFrom: a, aTo: 0, aT0: t, aDur: REDUCED ? 0 : RELEASE_S * a });
  requestRender();
}

// ---------- 受付 ----------
const station = createStation({
  button,
  feed: false,
  onState(s) {
    button.dataset.state = s;
    if (s === 'holding' || s === 'waiting-second') engage();
  },
  onTicket(t) {
    unfreeze();
    showRows(ticketRows(t, false));
    release(t.result.estimateMs, clock());
  },
  onVoid(v) {
    showRows([`無効票　${v.reasonText}`]);
  },
  onExpire() {
    const last = station.last();
    if (last) showRows(ticketRows(last, true));
  },
});

modeBtn.addEventListener('click', () => {
  const on = modeBtn.getAttribute('aria-pressed') !== 'true';
  modeBtn.setAttribute('aria-pressed', String(on));
  station.setMode(on ? 'twice' : 'hold');
  button.focus({ preventScroll: true });
});

// URL の票。時計の目量は 0.1 ms（揺らぎあり）と置き、キーボードで1回押したとして計算の芯に通す
if (URL_D !== null) {
  const hold = {
    ok: true, status: 'measured', mode: 'hold',
    input: { press: 'keyboard', release: 'keyboard' },
    durationMs: URL_D,
    pointerReport: { press: null, release: null },
  };
  const clockModel = { perfTick: { ok: true, tickMs: 0.1, jitter: true }, eventTick: { ok: true, tickMs: 0.1, jitter: true } };
  const result = GUM.evaluate({ holds: [hold], clock: clockModel });
  const decision = DEC.decide(result, TOL, { issuedAtEpochMs: 0 });
  const t = { hold, result, decision, n: 1 };
  showRows(ticketRows(t, Boolean(decision.certificate) && URL_T >= DEC.CERTIFICATE_VALIDITY_MS / 1000));
  release(result.estimateMs, 0);
}

// ---------- 描く道具 ----------
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('#view'), antialias: true, powerPreference: 'high-performance' });
} catch {
  renderer = null;
}
if (!renderer) {
  document.documentElement.classList.add('no-webgl');
  window.__ready = true;
}

function requestRender() {
  if (!renderer || raf) return;
  raf = requestAnimationFrame(frame);
}

if (renderer) await buildAndStart();

// =====================================================================
async function buildAndStart() {
  await loadFonts();
  TX.setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

  renderer.setPixelRatio(DPR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.4;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.setClearColor('#0b0f0e', 1);

  const scene = new THREE.Scene();
  const parts = new Set();
  const rig = build(scene, parts);
  const env = buildEnvironment(renderer, scene, rig.world, [rig.bal]);
  scene.environment = env.plain;
  scene.environmentIntensity = ENV_K;
  // 金属とケースのガラスの映りにはロビーの灯りを入れた環境を使う
  scene.traverse((o) => {
    const m = o.material;
    if (!o.isMesh || !m || !m.isMeshPhysicalMaterial) return;
    if (m.metalness >= 0.5 || m.blending === THREE.AdditiveBlending) {
      m.envMap = env.withLobby;
      m.envMapIntensity = ENV_K;
    }
  });

  const camera = new THREE.PerspectiveCamera(21, 1, 40, 9000);
  const view = { yaw: 0, pitch: 0, dYaw: 0, dPitch: 0, D: 2000, target: new THREE.Vector3() };

  // 部品の表と画面の部品を突き合わせる
  let table = [];
  try { table = await (await fetch('./parts.json')).json(); } catch { table = []; }
  const ids = new Set(table.map((p) => p.id));
  window.__parts = {
    onScreen: [...parts].sort(),
    notInTable: [...parts].filter((p) => !ids.has(p)),
    notOnScreen: [...ids].filter((p) => !parts.has(p)),
    count: table.reduce((s, p) => s + (p.count ?? 1), 0),
  };
  if (window.__parts.notInTable.length || window.__parts.notOnScreen.length) console.warn('部品の表と画面が合わない', window.__parts);

  function pose(st) {
    const { a, theta } = st;
    const lift = LIFT * a;
    rig.beam.position.y = PIV + lift;
    rig.beam.rotation.z = theta;
    for (const h of rig.hangers) {
      h.group.position.set(h.side * ARM * Math.cos(theta), PIV + lift + h.side * ARM * Math.sin(theta), 0);
    }
    rig.beamArrest.position.y = -BEAM_DROP * (1 - a);
    for (const p of rig.panArrests) p.position.y = -PAN_DROP * (1 - a);
    rig.knob.rotation.z = Math.PI * a;
    rig.scaleLamp.intensity = rig.scaleLampPower * (1 - a);
    rig.lens.emissiveIntensity = rig.lensPower * (1 - a);
  }

  function landscape() {
    const w = window.innerWidth, h = window.innerHeight;
    return !(w / h <= 1 || w <= 760);
  }

  function place() {
    const yaw = (view.yaw + view.dYaw) * DEG, pitch = (view.pitch + view.dPitch) * DEG;
    camera.position.set(
      view.target.x + view.D * Math.sin(yaw) * Math.cos(pitch),
      view.target.y + view.D * Math.sin(pitch),
      view.target.z + view.D * Math.cos(yaw) * Math.cos(pitch),
    );
    camera.lookAt(view.target);
    camera.updateMatrixWorld();
  }

  // 箱を画面の区画に収める。距離を二分法で決め、ずれは setViewOffset で寄せる
  function fit() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    const land = landscape();
    const box = land ? { x0: -250, x1: 262, y0: 0, y1: 480, z0: -135, z1: 140 } : { x0: -250, x1: 250, y0: 10, y1: 485, z0: -130, z1: 140 };
    const reg = land ? { x0: 0.42, x1: 0.965, y0: 0.09, y1: 0.95 } : { x0: 0.035, x1: 0.965, y0: 0.15, y1: 0.585 };
    view.yaw = land ? 16 : 9;
    view.pitch = land ? 13 : 10;
    view.target.set((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2);
    camera.aspect = w / h;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    const corners = [];
    for (const x of [box.x0, box.x1]) for (const y of [box.y0, box.y1]) for (const z of [box.z0, box.z1]) corners.push(new THREE.Vector3(x, y, z));
    // 窓口番号の札も枠に入れる（前の下の角と上の角）
    for (const dx of [-58, 58]) {
      corners.push(new THREE.Vector3(PLATE.x + dx * PLATE.s, 0, PLATE.z + 40 * PLATE.s));
      corners.push(new THREE.Vector3(PLATE.x + dx * PLATE.s, 125 * PLATE.s, PLATE.z + 10 * PLATE.s));
    }
    const v = new THREE.Vector3();
    const measure = () => {
      place();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of corners) {
        v.copy(c).project(camera);
        const px = ((v.x + 1) / 2) * w, py = ((1 - v.y) / 2) * h;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      return { minX, maxX, minY, maxY };
    };
    const rw = (reg.x1 - reg.x0) * w, rh = (reg.y1 - reg.y0) * h;
    let lo = 300, hi = 20000;
    view.dYaw = 0; view.dPitch = 0;
    for (let i = 0; i < 40; i++) {
      view.D = (lo + hi) / 2;
      const m = measure();
      if (m.maxX - m.minX > rw || m.maxY - m.minY > rh) lo = view.D; else hi = view.D;
    }
    view.D = hi;
    const m = measure();
    const offX = (m.minX + m.maxX) / 2 - ((reg.x0 + reg.x1) / 2) * w;
    const offY = (m.minY + m.maxY) / 2 - ((reg.y0 + reg.y1) / 2) * h;
    camera.setViewOffset(w, h, offX, offY, w, h);
    view.dYaw = clampYaw(URL_VIEW[0]);
    view.dPitch = clampPitch(URL_VIEW[1]);
    place();
  }
  const clampYaw = (v) => (Number.isFinite(v) ? Math.max(-6, Math.min(6, v)) : 0);
  const clampPitch = (v) => (Number.isFinite(v) ? Math.max(-3, Math.min(3, v)) : 0);

  // 焦点（支点・指針・目盛り）の画面上の四角。撮影の切り出しに使う
  window.__focusRect = () => {
    const pts = [[-80, 92, 18], [80, 92, 18], [-80, 440, 0], [80, 440, 0], [-80, 92, -10], [80, 440, 20]];
    const w = window.innerWidth, h = window.innerHeight;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y, z] of pts) {
      const p = new THREE.Vector3(x, y, z).project(camera);
      const px = ((p.x + 1) / 2) * w, py = ((1 - p.y) / 2) * h;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };

  // 世界の点を画面の位置に（撮影と構図の確かめに使う）
  window.__project = (x, y, z) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight };
  };

  frame = (now) => {
    raf = 0;
    const st = stateAt(clock());
    pose(st);
    renderer.render(scene, camera);
    window.__stats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frames: (window.__stats?.frames ?? 0) + 1, moving: st.moving };
    if (st.moving && !frozen) requestRender();
  };

  // 視点を数度だけ動かす
  const canvas = renderer.domElement;
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: view.dYaw, pitch: view.dPitch };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    view.dYaw = clampYaw(drag.yaw - (e.clientX - drag.x) * 0.03);
    view.dPitch = clampPitch(drag.pitch + (e.clientY - drag.y) * 0.02);
    place();
    requestRender();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('dragging');
    button.focus({ preventScroll: true });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => { fit(); requestRender(); });
  fit();
  renderer.compile(scene, camera);
  frame(0);
  window.__ready = true;
}

// ---------- 書体 ----------
async function loadFonts() {
  const jobs = [
    ['900 40px "Noto Serif JP"', '一秒の検定所'],
    ['700 40px "Noto Serif JP"', '一秒天秤　第一号'],
    ['700 40px "Noto Sans JP"', '番窓口止放短長秤量感度目零点付近（）≈'],
    ['500 40px "Noto Sans JP"', '夜間受付　窓口記号一秒だと思う長さ'],
    ['600 40px "IBM Plex Mono"', '0123456789 .sSEC=≈ms'],
  ];
  const all = Promise.all(jobs.map(([f, t]) => document.fonts.load(f, t).catch(() => null)));
  await Promise.race([all, new Promise((r) => setTimeout(r, 5000))]);
}

// ---------- 形の道具 ----------
function V2(x, y) { return new THREE.Vector2(x, y); }

/** 角を面取りした箱。押し出しの面取りで縁に光が乗る。UV は mm のまま（木目用）。 */
function rBox(w, h, d, r = 0.6, seg = 2) {
  r = Math.max(0.05, Math.min(r, w / 2 - 0.02, h / 2 - 0.02, d / 2 - 0.02));
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2 + r);
  s.lineTo(w / 2 - r, -h / 2 + r);
  s.lineTo(w / 2 - r, h / 2 - r);
  s.lineTo(-w / 2 + r, h / 2 - r);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d - 2 * r, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: seg, curveSegments: 1 });
  g.translate(0, 0, -(d - 2 * r) / 2);
  return g;
}

/** 回転体。profile は [半径, 高さ] の列。 */
function lathe(profile, seg = 64) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => V2(Math.max(0, r), y)), seg);
}

/** 多角形を z に押し出す（中心を z = 0）。 */
function prism(points, depth, bevel = 0) {
  const s = new THREE.Shape(points.map(([x, y]) => V2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, bevel > 0
    ? { depth: depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1 }
    : { depth, bevelEnabled: false });
  g.translate(0, 0, bevel > 0 ? -(depth - 2 * bevel) / 2 : -depth / 2);
  return g;
}

/** ローレットの摘み。歯の数 teeth の星形を z に押し出す。 */
function knurl(rOut, rIn, teeth, depth) {
  const pts = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? rOut : rIn;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return prism(pts, depth, 0.25);
}

/** すり割りの付いた平らな頭のねじ。半円の柱2つを溝の幅だけ離す。軸は +z、底が z = 0。 */
function slottedHead(r, h) {
  const g = r * 0.17, b = Math.min(0.12, h * 0.2), R = r - b, n = 14;
  const a0 = Math.asin(g / R);
  const half = (s) => {
    const sh = new THREE.Shape();
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((Math.PI - 2 * a0) * i) / n;
      const p = V2(R * Math.cos(a), s * R * Math.sin(a));
      if (i === 0) sh.moveTo(p.x, p.y); else sh.lineTo(p.x, p.y);
    }
    sh.closePath();
    return sh;
  };
  const geo = new THREE.ExtrudeGeometry([half(1), half(-1)], { depth: h - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 1 });
  geo.translate(0, 0, b);
  return geo;
}

/**
 * 断面が菱形の針。st は上から下へ [y, 半幅, 半厚]。前の稜線の両脇だけ法線をなめらかにつなぎ、
 * 左右の面の明るさの差の境に光の筋を1本通す。中心が z = 0。
 */
function diamondBlade(st) {
  const pos = [], nrm = [];
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  // 断面の帯。[点 A, A の法線, 点 B, B の法線]。点は (x, z)
  const bands = (hw, ht) => {
    const nl = v3(-ht, 0, hw).normalize(), nr = v3(ht, 0, hw).normalize();
    const bl = v3(-ht, 0, -hw).normalize(), br = v3(ht, 0, -hw).normalize(), nf = v3(0, 0, 1);
    const L = [-hw, 0], FL = [-0.2 * hw, 0.8 * ht], F = [0, ht], FR = [0.2 * hw, 0.8 * ht], Rr = [hw, 0], B = [0, -ht];
    return [[L, nl, FL, nl], [FL, nl, F, nf], [F, nf, FR, nr], [FR, nr, Rr, nr], [Rr, br, B, br], [B, bl, L, bl]];
  };
  const tri = (a, b, c) => {
    // 面の向きを渡した法線に合わせる
    const fn = v3().subVectors(b.p, a.p).cross(v3().subVectors(c.p, a.p));
    const avg = v3().add(a.n).add(b.n).add(c.n);
    const list = fn.dot(avg) >= 0 ? [a, b, c] : [a, c, b];
    for (const q of list) { pos.push(q.p.x, q.p.y, q.p.z); nrm.push(q.n.x, q.n.y, q.n.z); }
  };
  for (let i = 0; i + 1 < st.length; i++) {
    const [y0, hw0, ht0] = st[i], [y1, hw1, ht1] = st[i + 1];
    const b0 = bands(hw0, ht0), b1 = bands(hw1, ht1);
    for (let k = 0; k < b0.length; k++) {
      const P = { p: v3(b0[k][0][0], y0, b0[k][0][1]), n: b0[k][1] }, Q = { p: v3(b0[k][2][0], y0, b0[k][2][1]), n: b0[k][3] };
      const P1 = { p: v3(b1[k][0][0], y1, b1[k][0][1]), n: b1[k][1] }, Q1 = { p: v3(b1[k][2][0], y1, b1[k][2][1]), n: b1[k][3] };
      tri(P, Q, Q1);
      tri(P, Q1, P1);
    }
  }
  // 上と下のふた
  for (const [j, ny] of [[0, 1], [st.length - 1, -1]]) {
    const [y, hw, ht] = st[j];
    const ring = [[-hw, 0], [0, ht], [hw, 0], [0, -ht]].map(([x, z]) => ({ p: v3(x, y, z), n: v3(0, ny, 0) }));
    tri(ring[0], ring[1], ring[2]);
    tri(ring[0], ring[2], ring[3]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return geo;
}

/** 点列を通る針金。 */
function wire(points, r, seg = 200, radial = 8) {
  const c = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return new THREE.TubeGeometry(c, seg, r, radial, false);
}

/** 平面の UV を位置から作り直す（板に刷った文字を正しく貼る）。 */
function planarUV(g, x0, x1, y0, y1) {
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) - x0) / (x1 - x0);
    uv[i * 2 + 1] = (p.getY(i) - y0) / (y1 - y0);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** 凸の多角形（反時計回り）を内側へ d だけ縮める。 */
function inset(poly, d) {
  const n = poly.length;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    lines.push([x0 + nx * d, y0 + ny * d, x1 - x0, y1 - y0]);
  }
  const outp = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay, adx, ady] = lines[(i + n - 1) % n];
    const [bx, by, bdx, bdy] = lines[i];
    const den = adx * bdy - ady * bdx;
    const t = ((bx - ax) * bdy - (by - ay) * bdx) / den;
    outp.push([ax + adx * t, ay + ady * t]);
  }
  return outp;
}
function ccw(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a > 0 ? poly : poly.slice().reverse();
}

// ---------- 場面 ----------
function build(scene, parts) {
  const put = (parent, geom, mat, part, p = [0, 0, 0], r = [0, 0, 0], { cast = true, receive = true } = {}) => {
    const m = new THREE.Mesh(geom, mat);
    m.position.set(p[0], p[1], p[2]);
    m.rotation.set(r[0], r[1], r[2]);
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.userData.part = part;
    parts.add(part);
    parent.add(m);
    return m;
  };
  const phys = (o) => new THREE.MeshPhysicalMaterial(o);

  // ---- 材料 ----
  const wood = TX.woodTexture(3, { base: '#31251f', dark: '#171311', light: '#49382f' });
  wood.repeat.set(1 / 520, 1 / 520);
  const woodV = wood.clone();
  woodV.center.set(0.5, 0.5);
  woodV.rotation = Math.PI / 2;
  woodV.repeat.set(1 / 520, 1 / 520);
  woodV.needsUpdate = true;
  const agateTex = TX.agateTexture(17);
  agateTex.wrapS = agateTex.wrapT = THREE.RepeatWrapping;
  agateTex.repeat.set(1 / 26, 1 / 26);
  const M = {
    // 漆を掛けた真鍮。艶の層（clearcoat）を真鍮の上に重ねる
    brass: phys({ color: '#d6c79f', metalness: 1, roughness: 0.22, clearcoat: 0.55, clearcoatRoughness: 0.14 }),
    // 梁は金色の漆の真鍮。少し赤みを抜いた色
    beam: phys({ color: '#d8c798', metalness: 1, roughness: 0.18, clearcoat: 0.7, clearcoatRoughness: 0.1 }),
    // ニッケルめっき（支柱）と洋白（皿）
    nickel: phys({ color: '#cfcabd', metalness: 1, roughness: 0.34 }),
    // 皿の洋白は磨きを落とした地。灯りの当たる面が明るく読める
    silver: phys({ color: '#ddd9cf', metalness: 1, roughness: 0.24 }),
    // 焼入れ鋼（ナイフエッジ）。研いだ筋の向きに伸びる映り
    steel: phys({ color: '#b5b9bc', metalness: 1, roughness: 0.38, anisotropy: 0.55 }),
    // 青焼きの鋼（指針）。拡散を持たない金属にして、目盛り灯の緑を面で拾わない
    blued: phys({ color: '#34507c', metalness: 1, roughness: 0.34 }),
    agate: phys({ map: agateTex, metalness: 0, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04 }),
    // アルミの摘み
    alu: phys({ color: '#d2d4d3', metalness: 1, roughness: 0.42, anisotropy: 0.4 }),
    woodH: phys({ map: wood, roughness: 0.5, clearcoat: 0.55, clearcoatRoughness: 0.22 }),
    woodV: phys({ map: woodV, roughness: 0.5, clearcoat: 0.55, clearcoatRoughness: 0.22 }),
    ivory: phys({ color: '#eee6cf', roughness: 0.34, clearcoat: 0.35, clearcoatRoughness: 0.25 }),
    felt: new THREE.MeshStandardMaterial({ color: '#2c2a26', roughness: 1 }),
    paint: phys({ color: '#2a3330', roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4 }),
    paintBlack: phys({ color: '#161817', roughness: 0.5, clearcoat: 0.2 }),
    enamelWhite: phys({ color: '#d9d5c9', roughness: 0.3 }),
    edge: phys({ color: '#1f2120', roughness: 0.4, clearcoat: 0.25 }),
    // ガラスは映り込みだけを足す（拡散の色は持たない）。影は落とさない
    glass: phys({
      color: '#000000', metalness: 0, roughness: 0.04, ior: 1.5, specularIntensity: 1,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
    // 検査灯の乳白ガラス。この面が灯りそのもの
    opal: new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffe4c4', emissiveIntensity: 9, roughness: 1 }),
    // 目盛り灯の緑青のガラス
    lens: new THREE.MeshStandardMaterial({ color: '#06120d', emissive: '#3f9a79', emissiveIntensity: 0, roughness: 0.3 }),
    bubble: phys({ color: '#dfe3dc', roughness: 0.08, clearcoat: 1 }),
    // ガラスの吸収。奥の物を1枚ごとに少し暗く緑に寄せる（板ガラスの小口の色）
    glassBody: new THREE.MeshBasicMaterial({ color: '#0f1d18', transparent: true, opacity: 0.045, depthWrite: false, side: THREE.DoubleSide }),
  };
  // ガラスは環境（検査灯の乳白ガラスを含む）の映りだけを持ち、点の灯りの照り返しは描かない。
  // 目盛り灯がガラスの奥に浮いた点として映るのを避けるため
  M.glass.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directSpecular = vec3( 0.0 );');
  };
  const counterTex = TX.speckleTexture(41, '#4f524b', ['#42443e', '#5d6058', '#484a44', '#6c6e66']);
  counterTex.repeat.set(1 / 260, 1 / 260);
  M.counter = phys({ map: counterTex, roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5 });

  const world = new THREE.Group();
  scene.add(world);

  // ---- 窓口の天板と前縁 ----
  put(world, rBox(2800, 30, 340 - WALL_Z, 2), M.counter, 'counter', [0, -15, (340 + WALL_Z) / 2]);
  put(world, rBox(2800, 34, 14, 6, 3), M.edge, 'counter', [0, -15, 347]);

  // ---- 奥の仕切り（塗装した鋼板） ----
  {
    const W = 3600, H = 1800;
    const tex = TX.partitionTexture(W, H, [-1180, -560, 560, 1180]);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.74, metalness: 0.12 });
    put(world, new THREE.PlaneGeometry(W, H), mat, 'partition', [0, -30 + H / 2, WALL_Z], [0, 0, 0], { cast: false });
  }

  // ---- 窓口番号の札 ----
  {
    const g = new THREE.Group();
    g.position.set(PLATE.x, 0, PLATE.z);
    g.rotation.y = 0.2;
    g.scale.setScalar(PLATE.s);
    world.add(g);
    put(g, rBox(150, 4, 66, 1), M.paintBlack, 'window_plate', [0, 2, -2]);
    const tilt = -12 * DEG;
    const up = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
    const nrm = new THREE.Vector3(0, -Math.sin(tilt), Math.cos(tilt));
    const center = new THREE.Vector3(0, 4, 22).addScaledVector(up, 55);
    const body = put(g, rBox(150, 110, 3, 0.9), M.paintBlack, 'window_plate', center.toArray(), [tilt, 0, 0]);
    const face = new THREE.MeshPhysicalMaterial({ map: TX.windowPlateTexture(150, 110), roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.08 });
    const fc = center.clone().addScaledVector(nrm, 1.52);
    put(g, new THREE.PlaneGeometry(146, 106), face, 'window_plate', fc.toArray(), [tilt, 0, 0], { cast: false });
    // 後ろの脚
    const top = center.clone().addScaledVector(up, 20).addScaledVector(nrm, -1.5);
    const foot = new THREE.Vector3(0, 4, -30);
    const len = top.distanceTo(foot);
    const strut = put(g, rBox(46, len, 3, 0.8), M.paintBlack, 'window_plate', top.clone().add(foot).multiplyScalar(0.5).toArray());
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(foot).normalize());
    body.userData.part = 'window_plate';
  }

  // ---- 検査灯 ----
  const lampPos = new THREE.Vector3(...KEY.pos);
  const lampAim = new THREE.Vector3(...KEY.aim);
  const lampDir = lampAim.clone().sub(lampPos).normalize();
  {
    const apex = lampPos.clone().addScaledVector(lampDir, -100);
    const shade = new THREE.Group();
    shade.position.copy(apex);
    shade.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), lampDir);
    world.add(shade);
    const outer = [[0, 0], [13, 0], [22, -9], [40, -34], [58, -66], [71, -92], [77, -106], [78.5, -110]];
    // 外側は下から上へ（面が外を向く）、内側は上から下へ回して縁でつなぐ（面が内を向く）
    const inner = [[0, -0.6], ...outer.slice(1).map(([r, y]) => [r - 1.6, y - 0.6]), [78.5, -110]];
    put(shade, lathe(outer.slice().reverse(), 72), M.paint, 'lamp_shade', [0, 0, 0], [0, 0, 0], { cast: false });
    put(shade, lathe(inner, 72), M.enamelWhite, 'lamp_shade', [0, 0, 0], [0, 0, 0], { cast: false });
    put(shade, lathe([[0, 0], [8, 0], [8, 22], [0, 22]], 32), M.paint, 'lamp_shade', [0, 0, 0], [0, 0, 0], { cast: false });
    put(shade, new THREE.CircleGeometry(74, 72), M.opal, 'lamp_glass', [0, -100, 0], [Math.PI / 2, 0, 0], { cast: false, receive: false });
    // 腕: 仕切りから水平に出て、笠の首まで下りる
    const neck = apex.clone().addScaledVector(lampDir, -22);
    const armY = 790;
    const horiz = new THREE.CylinderGeometry(7, 7, neck.z - WALL_Z, 24);
    put(world, horiz, M.paint, 'lamp_shade', [neck.x, armY, (neck.z + WALL_Z) / 2], [Math.PI / 2, 0, 0], { cast: false });
    put(world, new THREE.CylinderGeometry(6, 6, armY - neck.y, 24), M.paint, 'lamp_shade', [neck.x, (armY + neck.y) / 2, neck.z], [0, 0, 0], { cast: false });
    put(world, new THREE.SphereGeometry(10, 24, 16), M.paint, 'lamp_shade', [neck.x, armY, neck.z], [0, 0, 0], { cast: false });
    put(world, rBox(60, 60, 12, 2), M.paint, 'lamp_shade', [neck.x, armY, WALL_Z + 6], [0, 0, 0], { cast: false });
    // 灯りそのもの（2800 K に寄せた象牙色）
    const spot = new THREE.SpotLight('#ffdcb2', KEY.power, 0, KEY.angle, KEY.pen, 2);
    spot.position.copy(lampPos).addScaledVector(lampDir, -6);
    spot.target.position.copy(lampAim);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 80;
    spot.shadow.camera.far = 2400;
    spot.shadow.bias = -0.00008;
    spot.shadow.normalBias = 0.35;
    world.add(spot, spot.target);
  }

  // ---- 天秤 ----
  const bal = new THREE.Group();
  world.add(bal);

  // 調整ねじの脚（3本）
  for (const [x, z] of [[-200, 100], [200, 100], [0, -100]]) {
    put(bal, lathe([[0, 0], [15, 0], [15.6, 0.6], [15.2, 2.2], [4, 2.2], [4, 12.5], [0, 12.5]], 48), M.brass, 'feet', [x, 0, z]);
    put(bal, knurl(13, 12.1, 36, 6), M.brass, 'feet', [x, 5.4, z], [-Math.PI / 2, 0, 0]);
  }

  // 台の箱と引き出し
  put(bal, rBox(464, 40, 244, 1.5), M.woodH, 'base_box', [0, 32, 0]);
  put(bal, rBox(300, 28, 3, 0.8), M.woodH, 'base_box', [0, 32, 123.4]);
  put(bal, rBox(56, 5, 5, 2), M.brass, 'base_box', [0, 32, 130.4]);
  for (const x of [-24, 24]) put(bal, rBox(5, 5, 6, 1), M.brass, 'base_box', [x, 32, 126.8]);

  // 台板
  put(bal, rBox(484, 26, 264, 3, 3), M.woodH, 'base_board', [0, 65, 0]);

  // 銘板
  {
    const tx = TX.nameplateTextures(112, 18, `1 目 ≈ ${MS_PER_DIV.toFixed(1)} ms（零点付近）`);
    put(bal, rBox(112, 18, 1.2, 0.35), M.brass, 'nameplate', [-118, 65, 132.6]);
    const mat = phys({ map: tx.map, roughnessMap: tx.rm, metalnessMap: tx.rm, roughness: 1, metalness: 1, clearcoat: 0.4, clearcoatRoughness: 0.2 });
    put(bal, new THREE.PlaneGeometry(111.2, 17.2), mat, 'nameplate', [-118, 65, 133.22], [0, 0, 0], { cast: false });
  }
  // 摘みの表示板
  {
    const tx = TX.arrestDialTextures(44, 20);
    put(bal, rBox(44, 20, 1.2, 0.35), M.brass, 'arrest_dial', [0, 65, 132.6]);
    const mat = phys({ map: tx.map, roughnessMap: tx.rm, metalnessMap: tx.rm, roughness: 1, metalness: 1, clearcoat: 0.4, clearcoatRoughness: 0.2 });
    put(bal, new THREE.PlaneGeometry(43.2, 19.2), mat, 'arrest_dial', [0, 65, 133.22], [0, 0, 0], { cast: false });
  }
  // 止め装置の摘み（a = 1 で左の「止」、a = 0 で右の「放」を指す）
  const knob = new THREE.Group();
  knob.position.set(0, 65, 133.2);
  bal.add(knob);
  put(knob, lathe([[0, 0], [10.6, 0], [10.6, 1.4], [0, 1.4]], 48), M.alu, 'arrest_knob', [0, 0, 0], [Math.PI / 2, 0, 0]);
  put(knob, knurl(9, 8.35, 40, 12), M.alu, 'arrest_knob', [0, 0, 7.4]);
  put(knob, new THREE.CircleGeometry(8.3, 48), phys({ map: TX.knobFaceTexture(), metalness: 1, roughness: 0.38 }), 'arrest_knob', [0, 0, 13.42], [0, 0, 0], { cast: false });

  // 水準器
  {
    const g = new THREE.Group();
    g.position.set(178, BASE_TOP, 84);
    bal.add(g);
    put(g, lathe([[0, 0], [12, 0], [12, 5.6], [11.2, 6.4], [10.2, 6.4], [10.2, 5.4], [0, 5.4]], 48), M.brass, 'level');
    put(g, new THREE.CircleGeometry(10.2, 48), new THREE.MeshPhysicalMaterial({ map: TX.levelFaceTexture(), roughness: 0.5 }), 'level', [0, 5.42, 0], [-Math.PI / 2, 0, 0], { cast: false });
    const bub = put(g, new THREE.SphereGeometry(2.6, 24, 12), M.bubble, 'level', [0, 6.2, 0], [0, 0, 0], { cast: false });
    bub.scale.set(1, 0.32, 1);
    put(g, new THREE.SphereGeometry(10.6, 40, 8, 0, Math.PI * 2, 0, 0.32), M.glass, 'level', [0, 6.4 - 10.6 * Math.cos(0.32), 0], [0, 0, 0], { cast: false, receive: false });
  }

  // 支柱（台座・柱・頭をひとつの回転体で）
  put(bal, lathe([
    [0, BASE_TOP], [34, BASE_TOP], [34, 81], [33, 82.6], [31, 84.4], [29, 88], [20, 89.2], [14, 91.2], [11, 94], [10, 97],
    [10, 380], [11.6, 382], [12, 384], [12, 389], [16.6, 392.4], [16.6, 395.4], [16.2, 396], [0, 396],
  ], 72), M.nickel, 'column');
  put(bal, rBox(14, 3, 30, 0.4), M.agate, 'center_agate', [0, 397.5, 0]);

  // 指針の目盛り板（支点が中心の扇形）。刻みの根元が r 260、指針の先は 258.5 で止まる
  {
    const { r0, r1 } = SCALE, half = SCALE.halfDeg * DEG;
    const shape = new THREE.Shape();
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const a = -half + (2 * half * i) / n;
      const p = [r1 * Math.sin(a), -r1 * Math.cos(a)];
      if (i === 0) shape.moveTo(p[0], p[1]); else shape.lineTo(p[0], p[1]);
    }
    for (let i = n; i >= 0; i--) {
      const a = -half + (2 * half * i) / n;
      shape.lineTo(r0 * Math.sin(a), -r0 * Math.cos(a));
    }
    const bbox = { x0: -r1 * Math.sin(half), x1: r1 * Math.sin(half), y0: -r1, y1: -r0 * Math.cos(half) };
    const tex = TX.pointerScaleTexture(bbox, SCALE.R, BAND_DEG);
    const faceGeom = planarUV(new THREE.ShapeGeometry(shape, 1), bbox.x0, bbox.x1, bbox.y0, bbox.y1);
    const faceMat = phys({ map: tex, roughness: 0.48 });
    put(bal, faceGeom, faceMat, 'pointer_scale', [0, PIV, SCALE.z + 0.02], [0, 0, 0], { cast: false });
    const body = new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 1 });
    put(bal, body, M.ivory, 'pointer_scale', [0, PIV, SCALE.z - 1.4]);
    // 板の裏を上がる2本の柱と、板をそこへ留めるねじ（目盛りの外の ±12°）
    const head = slottedHead(1.4, 0.75);
    for (const s of [-1, 1]) {
      const a = s * SCALE.screwDeg * DEG;
      const x = SCALE.screwR * Math.sin(a), y = PIV - SCALE.screwR * Math.cos(a);
      put(bal, new THREE.CylinderGeometry(1.5, 1.5, y + 1.5 - BASE_TOP, 20), M.brass, 'pointer_scale', [x, (y + 1.5 + BASE_TOP) / 2, SCALE.z - 3.1]);
      put(bal, head, M.brass, 'pointer_scale', [x, y, SCALE.z], [0, 0, s * 0.5 + 0.3]);
    }
  }

  // 目盛り灯（止めを外している間だけ点く緑青の小さな灯り。手前の低い所から目盛り板を照らす）
  const scaleLampPower = 28000;
  const lensPower = 2.4;
  const SCALE_LAMP_ANGLE = 0.8;
  const scaleLamp = new THREE.SpotLight('#2D765D', 0, 0, SCALE_LAMP_ANGLE, 0.15, 2);
  {
    // 目盛り板の真下の手前に置き、板の左右で明るさが揃う距離を取る
    const at = new THREE.Vector3(0, 100, 100);
    const aim = new THREE.Vector3(0, PIV - (SCALE.r0 + SCALE.r1) / 2, SCALE.z);
    const dir = aim.clone().sub(at).normalize();
    const g = new THREE.Group();
    g.position.copy(at);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    bal.add(g);
    // 黒塗りの筒と真鍮の縁。口に緑青のガラス
    put(g, lathe([[0, -9.5], [3.2, -9.5], [4.8, -8.7], [5.4, -7.4], [5.4, 5.0], [0, 5.0]], 40), M.paintBlack, 'scale_lamp');
    put(g, lathe([[5.4, 4.8], [6.0, 5.0], [6.0, 7.2], [5.2, 7.4], [4.4, 7.4], [4.4, 6.6], [0, 6.6]], 40), M.brass, 'scale_lamp');
    put(g, new THREE.CircleGeometry(4.4, 32), M.lens, 'scale_lamp', [0, 6.65, 0], [-Math.PI / 2, 0, 0], { cast: false, receive: false });
    // 筒を左右から挟む U 字の腕と、傾きを留めるねじ。台板に立つ柱で支える
    for (const sx of [-1, 1]) {
      put(bal, rBox(1.2, 15, 7, 0.3), M.brass, 'scale_lamp', [at.x + sx * 6.6, at.y - 2.3, at.z]);
      put(bal, new THREE.CylinderGeometry(1.9, 1.9, 1.2, 20), M.brass, 'scale_lamp', [at.x + sx * 7.8, at.y, at.z], [0, 0, Math.PI / 2]);
    }
    put(bal, rBox(14.4, 1.6, 7, 0.3), M.brass, 'scale_lamp', [at.x, at.y - 9.4, at.z]);
    put(bal, new THREE.CylinderGeometry(1.8, 1.8, at.y - 10.2 - BASE_TOP, 16), M.brass, 'scale_lamp', [at.x, (at.y - 10.2 + BASE_TOP) / 2, at.z]);
    put(bal, lathe([[0, 0], [5.5, 0], [5.5, 1.6], [2.4, 3], [0, 3]], 24), M.brass, 'scale_lamp', [at.x, BASE_TOP, at.z]);
    scaleLamp.position.copy(at).addScaledVector(dir, 8);
    scaleLamp.target.position.copy(aim);
    // 灯りの口の型板。目盛り板の扇形を灯りから見た形に切り、板の外へ光を出さない
    scaleLamp.map = scaleMask(scaleLamp.position, aim, SCALE_LAMP_ANGLE);
    scaleLamp.castShadow = true;
    scaleLamp.shadow.mapSize.set(1024, 1024);
    scaleLamp.shadow.camera.near = 6;
    scaleLamp.shadow.camera.far = 420;
    scaleLamp.shadow.bias = -0.0002;
    scaleLamp.shadow.normalBias = 0.15;
    bal.add(scaleLamp, scaleLamp.target);
  }

  // 梁の止め（支柱を滑る筒と横木と爪。a で上下する）
  const beamArrest = new THREE.Group();
  bal.add(beamArrest);
  const yb = (x) => 2 + ((Math.abs(x) - 14) * 7.5) / 78; // 梁の下の縁（14 < |x| < 92）
  {
    const pinTop = PIV + LIFT + yb(52) - 0.4; // 梁の面取りの分だけ下げて、止めたときに梁の下の縁に触れる
    put(beamArrest, lathe([[10.3, 366], [13, 366], [13.6, 366.6], [13.6, 375.4], [13, 376], [10.3, 376], [10.3, 366]], 48), M.brass, 'beam_arrest');
    for (const s of [-1, 1]) {
      put(beamArrest, rBox(45, 5, 7, 1), M.brass, 'beam_arrest', [s * 35.4, 371.5, 0]);
      put(beamArrest, lathe([[0, 374], [1.4, 374], [1.4, pinTop - 1.6], [0.55, pinTop], [0, pinTop]], 20), M.brass, 'beam_arrest', [s * 52, 0, 0]);
    }
  }

  // 皿の止め（左右。a で上下する）
  const panArrests = [];
  for (const s of [-1, 1]) {
    put(bal, lathe([[0, BASE_TOP], [6.5, BASE_TOP], [6.5, 81.6], [5.6, 82.6], [0, 82.6]], 32), M.brass, 'pan_arrest', [s * ARM, 0, 0]);
    const g = new THREE.Group();
    bal.add(g);
    const top = PIV + LIFT + PAN_BOTTOM;
    put(g, new THREE.CylinderGeometry(2.4, 2.4, 90, 20), M.brass, 'pan_arrest', [s * ARM, top - 3.5 - 45, 0]);
    put(g, lathe([[0, top - 3.5], [2.4, top - 3.5], [8.6, top - 1.8], [9.1, top - 1.0], [0, top - 1.0]], 40), M.brass, 'pan_arrest', [s * ARM, 0, 0]);
    put(g, new THREE.CylinderGeometry(8.1, 8.1, 1.0, 40), M.felt, 'pan_arrest', [s * ARM, top - 0.5, 0]);
    panArrests.push(g);
  }

  // ライダーの送り棒と摘み（右の側板を抜けて外に摘み）。棒の左の端から前へ出した鉤が下がり、
  // 底の U でライダーの輪を受けて梁から浮かせている。棒は前の引き戸の上の框に隠れるので、
  // 鉤の底と輪は框の下の縁（正面から見て z = 0 で y 438）より下に置く
  {
    const y = RIDER_Y, z = -14;
    put(bal, new THREE.CylinderGeometry(2.2, 2.2, 242, 20), M.brass, 'rider_carrier', [117, y, z], [0, 0, Math.PI / 2]);
    const HW = 0.42, HU = 1.6, hy = 435.4; // 鉤の線の太さ、底の U の半径、底の高さ
    const hook = [[y, -13], [y, -6], [y - 0.4, -3.0], [y - 1.4, -1.9], [y - 2.6, -HU]];
    for (let i = 0; i <= 8; i++) {
      const t = (i / 8) * Math.PI;
      hook.push([hy + HU - HU * Math.sin(t), -HU * Math.cos(t)]);
    }
    hook.push([hy + HU + 1.6, HU]);
    put(bal, wire(hook.map(([hy_, hz]) => new THREE.Vector3(0, hy_, hz)), HW, 64, 8), M.brass, 'rider_carrier');
    put(bal, knurl(8, 7.4, 30, 14), M.brass, 'rider_carrier', [245, y, z], [0, Math.PI / 2, 0]);
    // ライダー。輪の内の上の縁が鉤の底に載る。脚の下の端は止めた梁の上の縁より 1 mm 上（放すと 1.8 mm）
    const RR = 1.4, RT = 0.35;
    const ringY = hy + HW - (RR - RT);
    const apex = ringY - (RR + RT);
    const legs = apex - 428.65;
    const rp = [[2.95, -legs], [2.75, -1.6], [1.8, -0.45], [0, 0], [-1.8, -0.45], [-2.75, -1.6], [-2.95, -legs]].map(([rz, dy]) => new THREE.Vector3(0, apex + dy, rz));
    put(bal, wire(rp, 0.42, 60, 8), M.alu, 'rider');
    put(bal, new THREE.TorusGeometry(RR, RT, 8, 24), M.alu, 'rider', [0, ringY, 0]);
  }

  // ---- 梁（支点を原点に、θ で回る） ----
  const beam = new THREE.Group();
  bal.add(beam);
  {
    // 外形。上の縁は |x| ≤ 90 で平ら（ライダーの目盛り）、下の縁は中央が深い
    const ring = [
      [-125, -9], [-101, -9], [-92, 9.5], [-14, 2], [14, 2], [92, 9.5], [101, -9], [125, -9],
      [125, 4.5], [106, 4.5], [90, 27], [-90, 27], [-106, 4.5], [-125, 4.5],
    ];
    const shape = new THREE.Shape(ring.map(([x, y]) => V2(x, y)));
    // ワーレンの三角の穴（片側5つ）。弦と斜材の幅は 2.0 mm
    const yt = 19, ycAt = (x) => yb(x) + 3;
    const nodes = [16, 26.667, 37.333, 48, 58.667, 69.333, 80];
    const tris = [];
    for (let i = 0; i + 2 < nodes.length; i++) {
      const [xa, xm, xb] = [nodes[i], nodes[i + 1], nodes[i + 2]];
      if (i % 2 === 0) tris.push([[xa, yt], [xm, ycAt(xm)], [xb, yt]]); // 上が底辺
      else tris.push([[xa, ycAt(xa)], [xb, ycAt(xb)], [xm, yt]]);         // 下が底辺
    }
    for (const s of [1, -1]) {
      for (const t of tris) {
        const poly = ccw(t.map(([x, y]) => [s * x, y]));
        const hole = inset(poly, 1.0).reverse();
        shape.holes.push(new THREE.Path(hole.map(([x, y]) => V2(x, y))));
      }
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: 2.4, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.4, bevelSegments: 1, curveSegments: 1 });
    g.translate(0, 0, -1.2);
    put(beam, g, M.beam, 'beam');
    // 中央の刃を締める金具。角を面取りし、前の面の2本のねじで刃を押さえる
    put(beam, rBox(22, 17, 11, 1.8, 1), M.beam, 'beam', [0, 9.5, 0]);
    const clampHead = slottedHead(1.25, 0.8);
    for (const s of [-1, 1]) put(beam, clampHead, M.nickel, 'beam', [s * 6.5, 14.8, 5.45], [0, 0, s * 0.6]);
    // 梁の目盛り（ライダーの位置を読む。中心 0、両側 10）
    const sMat = phys({ map: TX.beamScaleTexture(89, 8.8, 8), roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.12 });
    put(beam, new THREE.PlaneGeometry(178, 8), sMat, 'beam_scale', [0, 23, 1.66], [0, 0, 0], { cast: false });
    // 中央のナイフエッジ（刃先が下、刃先が支点）。ハブの前後へ 8.5 mm ずつ出す
    put(beam, prism([[0, 0], [4, 8], [-4, 8]], 28), M.steel, 'center_knife');
    // 両端のナイフエッジ（刃先が上）
    for (const s of [-1, 1]) put(beam, prism([[0, 0], [-3, -6], [3, -6]], 18), M.steel, 'end_knife', [s * ARM, 0, 0]);
    // 指針。刃より上でハブの前に出した腕から下がり、上の方は中央の刃の前を空けた二股の板。
    // 板の下から先までは断面が菱形の針で、先は目盛りの刻みの根元の手前（半径 258.5 mm）で止める
    put(beam, rBox(19, 4, 12.05, 0.5), M.blued, 'pointer', [0, 12, 11.525]);
    {
      const outer = [[9.5, 14], [-9.5, 14], [-9.5, 10], [-1.7, -36], [0, -42], [1.7, -36], [9.5, 10]];
      const shp = new THREE.Shape(ccw(outer).map(([x, y]) => V2(x, y)));
      shp.holes.push(new THREE.Path(ccw([[-6.4, 9.6], [0, -29], [6.4, 9.6]]).reverse().map(([x, y]) => V2(x, y))));
      const fork = new THREE.ExtrudeGeometry(shp, { depth: 0.46, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 1, curveSegments: 1 });
      fork.translate(0, 0, -0.23);
      put(beam, fork, M.blued, 'pointer', [0, 0, 17.9]);
      const T = POINTER_TIP;
      put(beam, diamondBlade([[-30, 1.6, 0.72], [-238, 0.9, 0.42], [-T + 6, 0.42, 0.22], [-T, 0.1, 0.06]]), M.blued, 'pointer', [0, 0, 17.9]);
      // 付け根の留めねじ（二股の板を腕に留める）
      put(beam, slottedHead(1.5, 0.8), M.nickel, 'pointer', [0, 12, 18.2], [0, 0, 0.4]);
    }
  }

  // ---- つり手・弓・皿（端の刃先の位置に吊る。向きは鉛直のまま） ----
  const hangers = [];
  for (const side of [-1, 1]) {
    const g = new THREE.Group();
    bal.add(g);
    hangers.push({ side, group: g });
    // つり手
    for (const z of [-6.5, 6.5]) put(g, rBox(10, 3.5, 5, 0.3), M.agate, 'stirrup', [0, 1.75, z]);
    for (const z of [-10, 10]) put(g, rBox(12, 30, 2, 0.4), M.brass, 'stirrup', [0, -3, z]);
    put(g, rBox(12, 4, 22, 0.5), M.brass, 'stirrup', [0, 10, 0]);
    put(g, rBox(12, 4, 22, 0.5), M.brass, 'stirrup', [0, -16, 0]);
    put(g, new THREE.TorusGeometry(2.6, 0.9, 10, 28), M.brass, 'stirrup', [0, -21.5, 0], [0, Math.PI / 2, 0]);
    // 弓
    put(g, new THREE.TorusGeometry(3.0, 0.9, 10, 28), M.brass, 'bow', [0, -25.3, 0]);
    put(g, new THREE.CylinderGeometry(1.3, 1.3, 4.6, 16), M.brass, 'bow', [0, -30.3, 0]);
    // 皿の受けの輪。管の上の縁が皿の外の斜面に下から当たる寸法（皿の縁の内側 1.2 mm）
    const RING_R = 36.4, ringY = -227.37;
    const path = [];
    const leg = (sx) => {
      const pts = [];
      // 輪から脚の下の曲がりへ
      for (let i = 0; i <= 8; i++) {
        const u = i / 8;
        const a = [sx * RING_R, ringY], c = [sx * 52, ringY], b = [sx * 52, -206];
        const x = (1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * c[0] + u * u * b[0];
        const y = (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * c[1] + u * u * b[1];
        pts.push([x, y]);
      }
      for (let y = -196; y > -84; y += 12) pts.push([sx * 52, y]);
      return pts;
    };
    path.push(...leg(-1));
    for (let i = 0; i <= 36; i++) {
      const a = Math.PI - (Math.PI * i) / 36;
      path.push([52 * Math.cos(a), -84 + 52 * Math.sin(a)]);
    }
    path.push(...leg(1).reverse());
    put(g, wire(path.map(([x, y]) => new THREE.Vector3(x, y, 0)), 0.9, 320, 10), M.brass, 'bow');
    put(g, new THREE.TorusGeometry(RING_R, 1.3, 10, 120), M.brass, 'bow', [0, ringY, 0], [Math.PI / 2, 0, 0]);
    // 皿（洋白の浅い皿）
    put(g, lathe([
      [0, -231], [22, -231], [28, -230.4], [32, -229], [35, -226.8], [37.4, -225], [37.6, -224.4],
      [37, -224.1], [34.4, -226.1], [31.4, -228.2], [27.6, -229.5], [22, -230.2], [0, -230.2],
    ], 96), M.silver, 'pan');
    if (side < 0) {
      // 秤量紙（持ち込まれた一秒を受ける紙。窓口の検印）
      const paper = new THREE.PlaneGeometry(30, 30);
      paper.rotateX(-Math.PI / 2);
      paper.rotateY(Math.PI / 4);
      put(g, paper, new THREE.MeshStandardMaterial({ map: TX.paperTexture(), roughness: 0.92 }), 'paper', [0, -230.05, 0]);
    } else {
      // 標準分銅 1 s
      // 摘みの玉（中心 -206.8、半径 4.8）
      const knobPts = [];
      for (let i = 0; i <= 14; i++) {
        const a = -0.78 + ((Math.PI / 2 + 0.78) * i) / 14;
        knobPts.push([4.8 * Math.cos(a), -206.8 + 4.8 * Math.sin(a)]);
      }
      put(g, lathe([[0, -230.2], [9.2, -230.2], [9.6, -229.8], [9.6, -228.6], [0, -228.6]], 64), M.brass, 'weight');
      const tx = TX.weightTextures(2 * Math.PI * 9.6, 12.4);
      const bodyMat = phys({ map: tx.map, roughnessMap: tx.rm, metalnessMap: tx.rm, roughness: 1, metalness: 1, clearcoat: 0.5, clearcoatRoughness: 0.15 });
      put(g, new THREE.CylinderGeometry(9.6, 9.6, 12.4, 72, 1, true, -Math.PI, Math.PI * 2), bodyMat, 'weight', [0, -222.4, 0]);
      put(g, lathe([[0, -216.2], [9.6, -216.2], [9.2, -215.4], [7.4, -214.5], [4.6, -213.5], [3.6, -212.6], [3.4, -211.4], ...knobPts], 64), M.brass, 'weight');
    }
  }

  // ---- ケース ----
  {
    // 柱と枠の断面は 11 mm 角。ガラスは枠の内側の寸法に合わせる
    const F = 11;
    for (const x of [-227, 227]) for (const z of [-117, 117]) put(bal, rBox(F, 397.5, F, 1), M.woodV, 'case_frame', [x, 276.75, z]);
    for (const z of [-117, 117]) put(bal, rBox(454 - F, F, F, 1), M.woodH, 'case_frame', [0, 470, z]);
    for (const x of [-227, 227]) {
      put(bal, rBox(F, F, 234 - F, 1), M.woodH, 'case_frame', [x, 470, 0]);
      put(bal, rBox(F, 10, 234 - F, 1), M.woodH, 'case_frame', [x, 85, 0]);
    }
    // 右の側だけ中の桟（ライダーの送り棒を通す）
    put(bal, rBox(F, F, 234 - F, 1), M.woodH, 'case_frame', [227, RIDER_Y, 0]);
    put(bal, rBox(454 - F, 10, F, 1), M.woodH, 'case_frame', [0, 85, -117]);
    // 前の引き戸（下の框 11、上の框 10、縦の框 8）
    put(bal, rBox(438, 11, 8, 1), M.woodH, 'sash', [0, 83.5, 121]);
    put(bal, rBox(438, 10, 8, 1), M.woodH, 'sash', [0, 459.5, 121]);
    for (const x of [-213, 213]) put(bal, rBox(8, 365.5, 8, 1), M.woodV, 'sash', [x, 271.75, 121]);
    put(bal, rBox(36, 5, 5, 2), M.brass, 'sash', [0, 83.5, 128.6]);
    for (const x of [-14, 14]) put(bal, rBox(4, 4, 4.5, 0.8), M.brass, 'sash', [x, 83.5, 126]);
    // ガラス
    const gl = (w, h, p, r) => {
      const geom = new THREE.PlaneGeometry(w, h);
      put(bal, geom, M.glassBody, 'case_glass', p, r, { cast: false, receive: false });
      put(bal, geom, M.glass, 'case_glass', p, r, { cast: false, receive: false });
    };
    gl(418, 365.5, [0, 271.75, 121]);
    gl(443, 374.5, [0, 277.25, -117], [0, Math.PI, 0]);
    gl(223, 374.5, [-227, 277.25, 0], [0, -Math.PI / 2, 0]);
    // 右の側は中の桟の上と下に分ける（下は台の枠の上の縁 90 から、上は天井の枠の下の縁 464.5 まで）
    const midLo = RIDER_Y - F / 2, midHi = RIDER_Y + F / 2;
    gl(223, midLo - 90, [227, (midLo + 90) / 2, 0], [0, Math.PI / 2, 0]);
    gl(223, 464.5 - midHi, [227, (464.5 + midHi) / 2, 0], [0, Math.PI / 2, 0]);
    gl(443, 223, [0, 470, 0], [-Math.PI / 2, 0, 0]);
  }

  return {
    beam, hangers, beamArrest, panArrests, knob,
    scaleLamp, scaleLampPower, lens: M.lens, lensPower,
    lampPos, world, bal,
  };
}

// ---------- 目盛り灯の型板 ----------
// 灯りの影のカメラと同じ投影で、目盛り板の扇形を白く塗る。外の縁と横は 2 mm 内側。
// 内の縁は指針の先の半径にする。灯りから見ると指針の先は板の上の r 256 に重なるので、指針に緑の光が当たらない
function scaleMask(from, to, angle) {
  const cam = new THREE.PerspectiveCamera((2 * angle) / DEG, 1, 1, 1000);
  cam.position.copy(from);
  cam.lookAt(to);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.filter = 'blur(3px)';
  g.fillStyle = '#fff';
  const r0 = POINTER_TIP, r1 = SCALE.r1 - 2, half = SCALE.halfDeg * DEG - 2 / SCALE.r1, n = 40;
  const ring = [];
  for (let i = 0; i <= n; i++) { const a = -half + (2 * half * i) / n; ring.push([r1 * Math.sin(a), PIV - r1 * Math.cos(a)]); }
  for (let i = n; i >= 0; i--) { const a = -half + (2 * half * i) / n; ring.push([r0 * Math.sin(a), PIV - r0 * Math.cos(a)]); }
  g.beginPath();
  ring.forEach(([x, y], i) => {
    const p = new THREE.Vector3(x, y, SCALE.z + 0.02).project(cam);
    const u = ((p.x + 1) / 2) * S, v = (1 - (p.y + 1) / 2) * S;
    if (i) g.lineTo(u, v); else g.moveTo(u, v);
  });
  g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- 映り込みの環境 ----------
// 天秤とケースを隠した本物の場面を、天秤の中心から焼く。明るい所は、検査灯の乳白ガラスと、
// その灯りを受けた天板・仕切り・札から来る。金属とガラスの映りには、カメラの後ろのロビーの灯り
// （呼び出しの表示機1つと天井の灯り2つ）も入れる。ロビーの灯りは焼くときだけ置き、描く物には入れない（画面の枠の外）。
// ロビーの灯りは天秤から 1.5〜2.5 m 離れているので、木や仕切りの拡散の明るさには入れない
function buildEnvironment(renderer, scene, world, hide) {
  const LOBBY = [
    // [位置, 幅, 高さ, 明るさ, 色, 向き（'face' は焼く中心へ向ける、'down' は下へ向ける）]
    [[-900, 520, 2480], 760, 210, 5.0, '#ffe4c4', 'face'],
    [[-560, 1650, 1080], 980, 280, 7.5, '#f3eee4', 'down'],
    [[620, 1650, 1560], 980, 280, 7.5, '#f3eee4', 'down'],
  ];
  const c = new THREE.Vector3(0, 260, 30);
  const lobby = new THREE.Group();
  for (const [p, w, h, k, col, dir] of LOBBY) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: '#000000', emissive: col, emissiveIntensity: k, roughness: 1 }));
    m.position.set(...p);
    if (dir === 'face') m.lookAt(c);
    else m.rotation.x = Math.PI / 2;
    lobby.add(m);
  }
  for (const o of hide) o.visible = false;
  world.position.copy(c).negate();
  world.updateMatrixWorld(true);
  const pm = new THREE.PMREMGenerator(renderer);
  const plain = pm.fromScene(scene, 0.012, 1, 12000).texture;
  world.add(lobby);
  world.updateMatrixWorld(true);
  const withLobby = pm.fromScene(scene, 0.012, 1, 12000).texture;
  pm.dispose();
  world.remove(lobby);
  for (const m of lobby.children) { m.geometry.dispose(); m.material.dispose(); }
  world.position.set(0, 0, 0);
  world.updateMatrixWorld(true);
  for (const o of hide) o.visible = true;
  return { plain, withLobby };
}
