// tex.js — 文字と模様を Canvas に描き、面に貼るテクスチャにする。
// 乱数は種つきの物だけを使い、同じ URL で同じ画素になるようにする。
// 文字は HTML と同じ書体（Noto Serif JP・Noto Sans JP・IBM Plex Mono）で描く。

import * as THREE from '../vendor/three/three.module.min.js';

export const FONT = {
  mono: '"IBM Plex Mono", "Noto Sans JP", monospace',
  sans: '"Noto Sans JP", sans-serif',
  serif: '"Noto Serif JP", serif',
};

/** mulberry32。種が同じなら同じ列。 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let ANISO = 8;
export const setAnisotropy = (n) => { ANISO = n; };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(c, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** マホガニーの木目。u の向きに走る。 */
export function woodTexture(seed, { base = '#4b2418', dark = '#26100a', light = '#6e3a24' } = {}) {
  const S = 1024;
  const [c, g] = makeCanvas(S, S);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  for (let band = 0; band < 26; band++) {
    const y = r() * S, h = 20 + r() * 70;
    g.globalAlpha = 0.10 + r() * 0.16;
    g.fillStyle = r() < 0.5 ? dark : light;
    for (const off of [-S, 0, S]) g.fillRect(0, y + off, S, h);
  }
  for (let i = 0; i < 300; i++) {
    const y0 = r() * S, amp = 1 + r() * 7, f = ((1 + Math.floor(r() * 3)) * Math.PI * 2) / S, ph = r() * 6.283;
    g.globalAlpha = 0.07 + r() * 0.22;
    g.strokeStyle = r() < 0.62 ? dark : light;
    g.lineWidth = 0.5 + r() * 2.0;
    for (const off of [-S, 0, S]) {
      g.beginPath();
      for (let x = 0; x <= S; x += 8) {
        const y = y0 + off + amp * Math.sin(x * f + ph) + 1.6 * Math.sin(x * f * 3 + ph * 2);
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
  }
  g.globalAlpha = 0.3;
  g.fillStyle = dark;
  for (let i = 0; i < 5000; i++) g.fillRect(r() * S, r() * S, 1 + r() * 4, 0.7);
  g.globalAlpha = 1;
  return toTexture(c, { repeat: true });
}

/** めのうの縞。乳白と灰と蜜色の同心の帯。 */
export function agateTexture(seed) {
  const S = 512;
  const [c, g] = makeCanvas(S, S);
  const r = rng(seed);
  const img = g.createImageData(S, S);
  const cx = S * (0.2 + r() * 0.2), cy = S * (0.1 + r() * 0.2);
  const k = 0.075 + r() * 0.02;
  const cols = [[226, 222, 212], [196, 191, 180], [170, 160, 140], [212, 205, 190], [150, 146, 138]];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx, dy = (y - cy) * 1.4;
      let d = Math.sqrt(dx * dx + dy * dy);
      d += 6 * Math.sin(x * 0.031 + y * 0.017) + 3 * Math.sin(y * 0.06 - x * 0.02);
      const b = d * k;
      const i = Math.floor(b) % cols.length;
      const t = b - Math.floor(b);
      const a = cols[i], bb = cols[(i + 1) % cols.length];
      const s = t * t * (3 - 2 * t);
      const p = (y * S + x) * 4;
      img.data[p] = a[0] + (bb[0] - a[0]) * s;
      img.data[p + 1] = a[1] + (bb[1] - a[1]) * s;
      img.data[p + 2] = a[2] + (bb[2] - a[2]) * s;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c);
}

/** 塗装した鋼板の仕切り。継ぎ目とねじ頭。u は幅 widthMm、v は高さ heightMm に対応する。 */
export function partitionTexture(widthMm, heightMm, seamsMm) {
  const W = 2048, H = Math.round((W * heightMm) / widthMm);
  const [c, g] = makeCanvas(W, H);
  const r = rng(11);
  g.fillStyle = '#2a302d';
  g.fillRect(0, 0, W, H);
  g.globalAlpha = 0.05;
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = r() < 0.5 ? '#000' : '#fff';
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  g.globalAlpha = 1;
  const px = (mm) => ((mm + widthMm / 2) / widthMm) * W;
  for (const s of seamsMm) {
    const x = px(s);
    g.fillStyle = '#121513'; g.fillRect(x - 2, 0, 3, H);
    g.fillStyle = '#3b423e'; g.fillRect(x + 1, 0, 1, H);
    for (let yy = 0.08; yy < 1; yy += 0.28) {
      for (const sx of [-14, 14]) {
        g.fillStyle = '#1a1e1c'; g.beginPath(); g.arc(x + sx, yy * H, 4, 0, 6.283); g.fill();
        g.fillStyle = '#3d4541'; g.beginPath(); g.arc(x + sx - 1, yy * H - 1, 2.4, 0, 6.283); g.fill();
      }
    }
  }
  return toTexture(c);
}

/** メラミン化粧板の細かい斑。 */
export function speckleTexture(seed, base, spots) {
  const S = 512;
  const [c, g] = makeCanvas(S, S);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 14000; i++) {
    g.globalAlpha = 0.05 + r() * 0.12;
    g.fillStyle = spots[Math.floor(r() * spots.length)];
    g.fillRect(r() * S, r() * S, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  g.globalAlpha = 1;
  return toTexture(c, { repeat: true });
}

/**
 * 真鍮の板に文字を彫って黒い蝋を入れた物。色の地図と、粗さ（G）・金属度（B）の地図の2枚を返す。
 * draw(ctx, ink, pxPerMm) で文字を描く。ink は文字の塗り。
 */
export function engravedBrass(widthMm, heightMm, pxPerMm, draw, { base = '#c6a55f', seed = 5 } = {}) {
  const W = Math.round(widthMm * pxPerMm), H = Math.round(heightMm * pxPerMm);
  const [c, g] = makeCanvas(W, H);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < H * 1.5; i++) {
    g.globalAlpha = 0.04 + r() * 0.06;
    g.fillStyle = r() < 0.5 ? '#f3e3b4' : '#7d6533';
    g.fillRect(0, r() * H, W, 0.6 + r());
  }
  g.globalAlpha = 1;
  draw(g, '#16130d', pxPerMm);
  const [c2, g2] = makeCanvas(W, H);
  g2.fillStyle = 'rgb(0,80,255)'; // 粗さ 0.31、金属度 1
  g2.fillRect(0, 0, W, H);
  draw(g2, 'rgb(0,190,0)', pxPerMm); // 文字は粗さ 0.75、金属度 0
  return { map: toTexture(c), rm: toTexture(c2, { srgb: false }) };
}

/**
 * 梁の目盛り。黒い漆の地に象牙色の刻み。上の縁から刻みを下ろし、その下に数字。
 * 中心が 0、左右に各 10。1 ごとに数字、0.1 ごとに刻む。
 */
export function beamScaleTexture(halfMm, unitMm, heightMm, P = 22) {
  const W = Math.round(2 * halfMm * P), H = Math.round(heightMm * P);
  const [c, g] = makeCanvas(W, H);
  g.fillStyle = '#151413';
  g.fillRect(0, 0, W, H);
  const x = (mm) => (mm + halfMm) * P;
  g.fillStyle = '#e2dbc6';
  g.fillRect(x(-10 * unitMm) - 0.08 * P, 0.35 * P, (20 * unitMm + 0.16) * P, 0.14 * P);
  for (let i = -100; i <= 100; i++) {
    const mm = (i / 10) * unitMm;
    const len = i % 10 === 0 ? 3.0 : i % 5 === 0 ? 2.2 : 1.35;
    const w = i % 10 === 0 ? 0.2 : 0.12;
    g.fillRect(x(mm) - (w * P) / 2, 0.35 * P, w * P, len * P);
  }
  g.font = `600 ${Math.round(3.6 * P)}px ${FONT.mono}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  for (let n = -10; n <= 10; n++) g.fillText(String(Math.abs(n)), x(n * unitMm), (heightMm - 0.6) * P);
  return toTexture(c);
}

/**
 * 指針の目盛り板。象牙色の板に黒の刻み。中央 0、左右に各 10、1 目盛りは梁の傾き 1°。
 * 板の座標（支点が原点、下が負）を bbox で canvas に写す。
 * R: 半径（mm）。base 刻みの根元の弧、long 数字の所の線の先、mid 間の線の先、short 半目の線の先、
 *    num 数字の中心、band 公差の帯の内と外。
 * bandDeg: 公差の両端が釣り合う傾き（°）。刻みの根元に緑青の帯で刷る。
 */
export function pointerScaleTexture(bbox, R, bandDeg, pxPerMm = 28) {
  const W = Math.round((bbox.x1 - bbox.x0) * pxPerMm), H = Math.round((bbox.y1 - bbox.y0) * pxPerMm);
  const [c, g] = makeCanvas(W, H);
  const r = rng(21);
  g.fillStyle = '#e6dfca';
  g.fillRect(0, 0, W, H);
  g.globalAlpha = 0.05;
  for (let i = 0; i < 6000; i++) {
    g.fillStyle = r() < 0.5 ? '#8d8166' : '#fffaf0';
    g.fillRect(r() * W, r() * H, 2 + r() * 6, 1);
  }
  g.globalAlpha = 1;
  const X = (mm) => (mm - bbox.x0) * pxPerMm;
  const Y = (mm) => (bbox.y1 - mm) * pxPerMm;
  const at = (rad, deg) => {
    const p = (deg * Math.PI) / 180;
    return [X(rad * Math.sin(p)), Y(-rad * Math.cos(p))];
  };
  const arc = (rad, d0, d1) => {
    g.beginPath();
    const n = Math.max(8, Math.ceil(Math.abs(d1 - d0) * 6));
    for (let i = 0; i <= n; i++) {
      const [px, py] = at(rad, d0 + ((d1 - d0) * i) / n);
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
  };
  // 公差の帯（刷り。光らない）。刻みの根元に重ね、刻みはその上に刷る
  g.strokeStyle = '#2D765D';
  g.lineWidth = (R.band[1] - R.band[0]) * pxPerMm;
  g.lineCap = 'butt';
  arc((R.band[0] + R.band[1]) / 2, -bandDeg, bandDeg);
  g.stroke();
  // 刻みは根元の弧から外へ下ろす。数字の所（2° ごと）が長、間（奇数の度）が中、半目が短
  g.strokeStyle = '#17140f';
  for (let k = -20; k <= 20; k++) {
    const deg = k / 2;
    const kind = k % 4 === 0 ? 'long' : k % 2 === 0 ? 'mid' : 'short';
    g.lineWidth = { long: 0.38, mid: 0.3, short: 0.24 }[kind] * pxPerMm;
    const [ax, ay] = at(R.base, deg), [bx, by] = at(R[kind], deg);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
  }
  g.lineWidth = 0.3 * pxPerMm;
  arc(R.base, -10, 10);
  g.stroke();
  g.fillStyle = '#17140f';
  g.font = `600 ${Math.round(4.4 * pxPerMm)}px ${FONT.mono}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const label = (text, deg, rad) => {
    const [px, py] = at(rad, deg);
    g.save();
    g.translate(px, py);
    g.rotate((-deg * Math.PI) / 180);
    g.fillText(text, 0, 0);
    g.restore();
  };
  // 数字は長い線の真下
  for (let d = -10; d <= 10; d += 2) label(String(Math.abs(d)), d, R.num);
  g.font = `700 ${Math.round(3.8 * pxPerMm)}px ${FONT.sans}`;
  label('短', -R.labelDeg, R.num);
  label('長', R.labelDeg, R.num);
  return toTexture(c);
}

/** 二重の菱形の検印。外形 sizeMm、線の幅 0.7 mm、中に窓口記号。 */
export function drawSeal(g, cx, cy, sizeMm, P, code, ink) {
  const h = (sizeMm * P) / 2;
  g.strokeStyle = ink;
  g.lineWidth = 0.7 * P;
  for (const s of [1, 0.8]) {
    g.beginPath();
    g.moveTo(cx, cy - h * s); g.lineTo(cx + h * s, cy); g.lineTo(cx, cy + h * s); g.lineTo(cx - h * s, cy); g.closePath();
    g.stroke();
  }
  g.fillStyle = ink;
  g.font = `600 ${Math.round(3.4 * P)}px ${FONT.mono}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(code, cx, cy + 0.2 * P);
}

/** 窓口の番号札。白いほうろうに黒の文字。 */
export function windowPlateTexture(wMm, hMm) {
  const P = 16;
  const W = wMm * P, H = hMm * P;
  const [c, g] = makeCanvas(W, H);
  g.fillStyle = '#e9e4d6';
  g.fillRect(0, 0, W, H);
  const ink = '#141413';
  g.fillStyle = ink;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.font = `600 ${Math.round(62 * P)}px ${FONT.mono}`;
  g.fillText('1', 9 * P, 58 * P);
  g.font = `700 ${Math.round(15 * P)}px ${FONT.sans}`;
  g.fillText('番窓口', 50 * P, 58 * P);
  g.fillRect(9 * P, 66 * P, (wMm - 18) * P, 0.8 * P);
  g.font = `900 ${Math.round(15.5 * P)}px ${FONT.serif}`;
  g.fillText('一秒の検定所', 9 * P, 89 * P);
  g.font = `500 ${Math.round(6.2 * P)}px ${FONT.sans}`;
  g.fillText('夜間受付　窓口記号 SEC', 9 * P, 102 * P);
  drawSeal(g, (wMm - 24) * P, 32 * P, 30, P, 'SEC', ink);
  return toTexture(c);
}

/** 止め装置の表示板。左が「止」、右が「放」。真鍮に彫る。 */
export function arrestDialTextures(wMm, hMm) {
  return engravedBrass(wMm, hMm, 48, (g, ink, P) => {
    g.fillStyle = ink;
    g.strokeStyle = ink;
    g.font = `700 ${Math.round(6.4 * P)}px ${FONT.sans}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('止', 6.2 * P, (hMm / 2 + 0.3) * P);
    g.fillText('放', (wMm - 6.2) * P, (hMm / 2 + 0.3) * P);
    g.lineWidth = 0.45 * P;
    const cx = (wMm / 2) * P, cy = (hMm / 2) * P;
    for (const dir of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + dir * 10.4 * P, cy);
      g.lineTo(cx + dir * 13.2 * P, cy);
      g.stroke();
    }
    g.lineWidth = 0.3 * P;
    g.beginPath();
    g.arc(cx, cy, 10.2 * P, Math.PI, 0);
    g.stroke();
  }, { seed: 9 });
}

/** 天秤の銘板。 */
export function nameplateTextures(wMm, hMm, sensitivityText) {
  return engravedBrass(wMm, hMm, 28, (g, ink, P) => {
    g.fillStyle = ink;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = `700 ${Math.round(6.0 * P)}px ${FONT.serif}`;
    g.fillText('一秒天秤　第一号', 4 * P, 8.6 * P);
    g.font = `600 ${Math.round(3.5 * P)}px ${FONT.mono}`;
    g.fillText(`秤量 1 s　感度 ${sensitivityText}`, 4 * P, 14.6 * P);
    g.textAlign = 'right';
    g.font = `600 ${Math.round(3.5 * P)}px ${FONT.mono}`;
    g.fillText('SEC', (wMm - 4) * P, 8.6 * P);
    g.lineWidth = 0.3 * P;
    g.strokeStyle = ink;
    g.strokeRect(1.4 * P, 1.4 * P, (wMm - 2.8) * P, (hMm - 2.8) * P);
  }, { seed: 7 });
}

/** 標準分銅の胴に彫る「1 s」。円筒の u=0.5 が正面に来るように描く。 */
export function weightTextures(circumMm, heightMm) {
  return engravedBrass(circumMm, heightMm, 40, (g, ink, P) => {
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `600 ${Math.round(8.2 * P)}px ${FONT.mono}`;
    g.fillText('1 s', (circumMm / 2) * P, (heightMm * 0.52) * P);
  }, { base: '#c9ab66', seed: 13 });
}

/** 秤量紙。紙の繊維と、窓口の検印。 */
export function paperTexture() {
  const S = 512;
  const [c, g] = makeCanvas(S, S);
  const r = rng(31);
  g.fillStyle = '#efece4';
  g.fillRect(0, 0, S, S);
  g.globalAlpha = 0.08;
  for (let i = 0; i < 3000; i++) {
    g.strokeStyle = r() < 0.5 ? '#b9b2a0' : '#ffffff';
    g.lineWidth = 0.6;
    const x = r() * S, y = r() * S, a = r() * 6.283;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6); g.stroke();
  }
  g.globalAlpha = 0.88;
  // 紙は 40 mm 角を45°回して置く。uv の中心に検印を押す。
  g.save();
  g.translate(S / 2, S / 2);
  g.rotate(Math.PI / 4);
  drawSeal(g, 0, 0, 18, S / 40 / Math.SQRT2 * 1.0, 'SEC', '#1d1b18');
  g.restore();
  g.globalAlpha = 1;
  return toTexture(c);
}

/** 止め装置の摘みの端面。アルミの地に黒の指標線。 */
export function knobFaceTexture() {
  const S = 256;
  const [c, g] = makeCanvas(S, S);
  const grd = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  grd.addColorStop(0, '#d4d6d6');
  grd.addColorStop(1, '#b8bbbc');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  for (let rr = 6; rr < S / 2; rr += 3) { g.beginPath(); g.arc(S / 2, S / 2, rr, 0, 6.283); g.stroke(); }
  g.fillStyle = '#141414';
  g.fillRect(S / 2, S / 2 - 7, S / 2 - 14, 14);
  return toTexture(c);
}

/** 水準器の目盛りの輪。 */
export function levelFaceTexture() {
  const S = 256;
  const [c, g] = makeCanvas(S, S);
  g.fillStyle = '#d9d6cb';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#1b1a17';
  g.lineWidth = 5;
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.18, 0, 6.283); g.stroke();
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(S / 2, S * 0.08); g.lineTo(S / 2, S * 0.22); g.moveTo(S / 2, S * 0.78); g.lineTo(S / 2, S * 0.92);
  g.moveTo(S * 0.08, S / 2); g.lineTo(S * 0.22, S / 2); g.moveTo(S * 0.78, S / 2); g.lineTo(S * 0.92, S / 2); g.stroke();
  return toTexture(c);
}
