// 一枚のガラス。打った言葉から、透明な板の裏の面の凹凸をこの端末で解き、平行な光を通して壁に映す。
//
// 解く: solver.js（Worker）。256 のマスで解いて届いたら組み替わりを始め、256 が 0.4 秒以内の端末は続けて 512 を解いて差し替える。
// 描く: WebGL2。板の網の頂点を屈折の先（壁の上）へ動かし、三角形ごとに「板の上の面積 / 壁の上の面積」を明るさにして加算で足す。
//       波長は3本（赤 630 nm、緑 540 nm、青 460 nm）で、アクリルの屈折率を波長ごとに使う。
//       足し合わせた明るさを、1つに決めた曲線で画面の値に直す。

import { makeTarget, wordWidth } from './target.js';

// ---------------------------------------------------------------- 決めた値

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const DIAG = params.get('diag') === '1';
const HOLD = TEST && params.get('hold') === '1'; // 試験: 最初の言葉を自動で解かず、glassTest.start を待つ
const ONLY256 = TEST && params.get('only256') === '1'; // 試験: 512 を解かない
const FORCE8 = params.get('rt') === '8'; // 8 bit の描き先の道を確かめるため

// 動きの間（ミリ秒）。hold: 開いてから距離が動き始めるまで、dist: 距離が 0 から設計の値まで動く長さ、
// morph: 言葉の組み替わり、swap: 256 から 512 への差し替え
const PACES = {
  1: { hold: 600, dist: 1200, morph: 1000, swap: 400 },
  2: { hold: 1000, dist: 2000, morph: 1500, swap: 500 },
  3: { hold: 1000, dist: 3000, morph: 2000, swap: 600 },
};
const PACE_ID = PACES[params.get('pace')] ? Number(params.get('pace')) : 2;
const PACE = PACES[PACE_ID];

const SIZE = 0.1; // 板の一辺（m）
const D0 = 0.2; // 設計の距離: 板の裏の面から壁まで（m）
const FIRST_WORD = '光で書く';
const MAX_WIDTH = 6; // 全角 1、半角 0.5 で数えた字数の上限
const SOLVE_512_UNDER_MS = 400;
const RENDER_GRID = 512; // 描く網のマスの数。256 の板は B スプラインで補って1マスを4つに割る
const MATERIAL = 'アクリル';
// 壁の正方形の一辺が描く網の 2 倍の画素に届かない画面では、1画素を4点で見る描き先に足してから平均する。
// 網の三角形が1画素より小さいと、画素の中心に当たるかどうかで明るさが粒になり、網の向きの縞も出るため
const MS_BELOW_PX_PER_CELL = 2;
const MS_SAMPLES = 4;
// 最初の言葉は、平らな板から解いた板へ組み替わりながら距離が動く。組み替わりは距離の動きの最初のこの割合で終える
const INTRO_FADE = 0.3;
// 描くのが遅い端末では、描く網を 256 に粗くする。続けて描いた直近 30 コマの間隔の中央値がこれを超えたとき（1回だけ）
const SLOW_FRAME_MS = 40;

// アクリル（ポリメタクリル酸メチル）の屈折率。λ は µm。
// n² − 1 = 1.1819 λ² / (λ² − 0.011313)（0.4368〜1.052 µm）
const nPMMA = (um) => Math.sqrt(1 + (1.1819 * um * um) / (um * um - 0.011313));
const WAVES_UM = [0.63, 0.54, 0.46];
const N_WAVE = WAVES_UM.map(nPMMA);

// 画面への直し方。x = K × 明るさ（平らな板で 1）、g = x / (1 + x^8)^(1/8)、画面の値 = g^GAMMA。
// 小さい所はほぼ x^GAMMA、1 を超えるとなだらかに 1 へ寄る。どの言葉・どの距離でも同じ
const TONE_K = 0.45;
const TONE_GAMMA = 1.25;

// 指の操作。上へなぞると壁が遠ざかる。DRAG_PX（css の画素）で設計の距離の1倍ぶん。左右は TILT_PX で1度、±TILT_MAX 度まで
const DRAG_PX = 240;
const TILT_PX = 30;
const TILT_MAX = 6;

const FONT = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', YuGothic, Meiryo, 'Noto Sans JP', 'Noto Sans CJK JP', 'Source Han Sans JP', sans-serif";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const now = () => performance.now();
// 動きの時計。ふだんは now と同じ。試験のときだけ、撮る瞬間の時刻に止められる（解く時間などの測りには使わない）
let frozenAt = null;
const clock = () => (frozenAt === null ? now() : frozenAt);

// ---------------------------------------------------------------- 描く側

const VS_LIGHT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uT;
uniform int uM;
uniform float uSize;
uniform float uDist;
uniform vec3 uI[3];
uniform float uEta[3];
uniform vec2 uCenter;
uniform float uPxPerM;
uniform vec2 uView;
out vec2 vU;
out float vOk;
flat out vec4 vMask;
void main() {
  int V = uM + 1;
  int c = gl_VertexID % V;
  int r = gl_VertexID / V;
  vec3 p = mix(texelFetch(uA, ivec2(c, r), 0).xyz, texelFetch(uB, ivec2(c, r), 0).xyz, uT);
  int w = gl_InstanceID;
  vec3 N = normalize(vec3(p.y, p.z, -1.0));
  vec3 T = refract(uI[w], N, uEta[w]);
  vec2 u = vec2(float(c), float(r)) / float(uM);
  vec2 x = (u - 0.5) * uSize;
  vec2 wall = x;
  float ok = 0.0;
  if (T.z > 1e-6) {
    wall = x + (uDist - p.x) / T.z * T.xy;
    ok = 1.0;
  }
  vec2 px = uCenter + wall * uPxPerM;
  gl_Position = vec4(px.x / uView.x * 2.0 - 1.0, 1.0 - px.y / uView.y * 2.0, 0.0, 1.0);
  vU = u;
  vOk = ok;
  vMask = w == 0 ? vec4(1.0, 0.0, 0.0, 0.0) : (w == 1 ? vec4(0.0, 1.0, 0.0, 0.0) : vec4(0.0, 0.0, 1.0, 0.0));
}`;

// 三角形の中で vU は1次なので、画面の画素あたりの vU の変わり方の行列式が、そのまま「板の上の面積 / 壁の上の面積」になる
const FS_LIGHT = `#version 300 es
precision highp float;
in vec2 vU;
in float vOk;
flat in vec4 vMask;
uniform float uArea;
uniform float uGain;
uniform float uMaxI;
out vec4 outColor;
void main() {
  if (vOk < 0.999) discard;
  vec2 a = dFdx(vU);
  vec2 b = dFdy(vU);
  float I = min(abs(a.x * b.y - a.y * b.x) * uArea, uMaxI);
  outColor = vMask * (I * uGain);
}`;

const VS_FULL = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_TONE = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uAcc;
uniform float uDecode;
uniform float uK;
uniform float uGamma;
out vec4 outColor;
void main() {
  vec3 E = texelFetch(uAcc, ivec2(gl_FragCoord.xy), 0).rgb * uDecode;
  vec3 x = clamp(E * uK, 0.0, 1.0e4);
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  vec3 g = x / pow(1.0 + x4 * x4, vec3(0.125));
  outColor = vec4(pow(g, vec3(uGamma)), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('影の段の組み立てに失敗: ' + gl.getShaderInfoLog(s));
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('影の段のつなぎに失敗: ' + gl.getProgramInfoLog(p));
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;
  const R = { gl, info: {} };
  const info = R.info;
  info.half = !!gl.getExtension('EXT_color_buffer_half_float');
  info.float = !!gl.getExtension('EXT_color_buffer_float');
  info.floatBlend = !!gl.getExtension('EXT_float_blend');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  info.gpu = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  info.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  const light = program(gl, VS_LIGHT, FS_LIGHT);
  const tone = program(gl, VS_FULL, FS_TONE);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const M = RENDER_GRID;
  const V = M + 1;
  // 三角形の並び。step 2 は頂点を1つおきに使う粗い網（遅い端末のため）
  const indices = (step) => {
    const m = M / step;
    const idx = new Uint32Array(m * m * 6);
    let o = 0;
    for (let r = 0; r < M; r += step) {
      for (let c = 0; c < M; c += step) {
        const k = r * V + c;
        const s = step;
        idx[o++] = k; idx[o++] = k + s; idx[o++] = k + s * V + s;
        idx[o++] = k; idx[o++] = k + s * V + s; idx[o++] = k + s * V;
      }
    }
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    return { buf: b, count: idx.length, grid: m };
  };
  const meshes = { fine: indices(1), coarse: indices(2) };
  R.coarse = false;
  info.drawGrid = M;
  const emptyVao = gl.createVertexArray();
  gl.bindVertexArray(null);

  // 1画素を何点で見る描き先が作れるか（作れなければ 0）
  const samplesFor = (fmt, want) => {
    try {
      const a = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES);
      gl.getError();
      if (!a) return 0;
      const ok = Array.from(a).filter((s) => s >= 2 && s <= want);
      return ok.length ? Math.max(...ok) : 0;
    } catch (_) {
      return 0;
    }
  };

  const plateTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, V, V);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, V, V, gl.RGBA, gl.FLOAT, new Float32Array(V * V * 4));
    return t;
  };
  R.tex = [plateTex(), plateTex()]; // [0] が混ぜる元 A、[1] が混ぜる先 B
  R.upload = (which, data) => {
    gl.bindTexture(gl.TEXTURE_2D, R.tex[which]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, V, V, gl.RGBA, gl.FLOAT, data);
  };
  R.swap = () => R.tex.reverse();

  const fmtOf = (kind) => (kind === '32F' ? gl.RGBA32F : kind === '16F' ? gl.RGBA16F : gl.RGBA8);

  // 描き先。kind は '32F'、'16F'、'8'。samples が 2 以上なら、1画素を何点かで見る描き先に足し、
  // resolve() で平均してテクスチャに移す（明るさは足し算なので、点の平均が画素の中の明るさの平均になる）
  const makeTarget = (w, h, kind, samples = 0) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const fmt = fmtOf(kind);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(t);
      return null;
    }
    let msFbo = null;
    let rb = null;
    let got = 0;
    const want = samples >= 2 ? samplesFor(fmt, samples) : 0;
    if (want) {
      while (gl.getError() !== gl.NO_ERROR) {}
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, want, fmt, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      msFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      const msOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (msOk) {
        got = want;
      } else {
        gl.deleteFramebuffer(msFbo);
        gl.deleteRenderbuffer(rb);
        msFbo = null;
        rb = null;
      }
    }
    // 8 bit の描き先は 1 を超えると切れるので、明るさを 4 で割って足し、直すときに 4 を掛ける
    const scale = kind === '8' ? 4 : 1;
    return {
      tex: t,
      fbo,
      drawFbo: msFbo || fbo,
      w,
      h,
      kind,
      samples: got,
      gain: 1 / scale,
      decode: scale,
      resolve() {
        if (!msFbo) return;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      },
      free() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(t);
        if (msFbo) {
          gl.deleteFramebuffer(msFbo);
          gl.deleteRenderbuffer(rb);
        }
      },
    };
  };
  R.makeTarget = makeTarget;

  // 画面の大きさの描き先を選ぶ。16 bit の浮動小数が作れなければ 8 bit。samples は1画素を見る点の数（0 なら1点）
  R.resize = (w, h, samples = 0) => {
    if (R.acc && R.acc.w === w && R.acc.h === h && R.acc.askSamples === samples) return;
    const want = R.acc ? R.acc.kind : null;
    if (R.acc) R.acc.free();
    R.acc = null;
    if (want) R.acc = makeTarget(w, h, want, samples);
    if (!R.acc && !FORCE8 && (info.half || info.float)) R.acc = makeTarget(w, h, '16F', samples);
    if (!R.acc) R.acc = makeTarget(w, h, '8', samples);
    if (R.acc) R.acc.askSamples = samples;
    info.target = R.acc ? (R.acc.kind === '16F' ? 'RGBA16F' : 'RGBA8') : 'なし';
    info.samples = R.acc ? R.acc.samples || 1 : 0;
  };

  // 描く網を粗くするか
  R.setCoarse = (on) => {
    R.coarse = !!on;
    info.drawGrid = R.coarse ? meshes.coarse.grid : meshes.fine.grid;
  };

  // 光を描き先に足す。s: {target, cx, cy, side（いずれも描き先の画素）, dist（m）, tilt（度）, t}
  R.drawLight = (s) => {
    const tg = s.target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, tg.drawFbo);
    gl.viewport(0, 0, tg.w, tg.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(light.p);
    const L = light.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, R.tex[0]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, R.tex[1]);
    gl.uniform1i(L.uA, 0);
    gl.uniform1i(L.uB, 1);
    gl.uniform1f(L.uT, s.t);
    gl.uniform1i(L.uM, M);
    gl.uniform1f(L.uSize, SIZE);
    gl.uniform1f(L.uDist, s.dist);
    const th = (s.tilt * Math.PI) / 180;
    const dirs = new Float32Array(9);
    N_WAVE.forEach((ng, i) => {
      // 板の外の光の向き (sin θ, 0, cos θ) が平らな表で曲がった後の、ガラスの中の向き
      const eta = 1 / ng;
      const lz = Math.cos(th);
      dirs[3 * i] = eta * Math.sin(th);
      dirs[3 * i + 1] = 0;
      dirs[3 * i + 2] = Math.sqrt(1 - eta * eta * (1 - lz * lz));
    });
    gl.uniform3fv(L.uI, dirs);
    gl.uniform1fv(L.uEta, new Float32Array(N_WAVE));
    gl.uniform2f(L.uCenter, s.cx, s.cy);
    gl.uniform1f(L.uPxPerM, s.side / SIZE);
    gl.uniform2f(L.uView, tg.w, tg.h);
    gl.uniform1f(L.uArea, s.side * s.side);
    gl.uniform1f(L.uGain, tg.gain);
    gl.uniform1f(L.uMaxI, 2000);
    const mesh = R.coarse ? meshes.coarse : meshes.fine;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.buf);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0, 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    tg.resolve();
  };

  // 足した明るさを画面の値に直す。dst が null なら画面へ
  R.drawTone = (src, dst) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, src.w, src.h);
    gl.useProgram(tone.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(tone.loc.uAcc, 0);
    gl.uniform1f(tone.loc.uDecode, src.decode);
    gl.uniform1f(tone.loc.uK, TONE_K);
    gl.uniform1f(tone.loc.uGamma, TONE_GAMMA);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };
  return R;
}

// ---------------------------------------------------------------- 画面の組み

const canvas = document.getElementById('wall');
const input = document.getElementById('word');
const ui = document.getElementById('ui');
const hint = document.getElementById('hint');
const numbersEl = document.getElementById('numbers');
const diagEl = document.getElementById('diag');

const view = { W: 0, H: 0, dpr: 1, side: 0, cx: 0, cy: 0 };

function layout() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const maxTex = renderer ? Math.min(renderer.info.maxTex, 4096) : 4096;
  // 描き先が大きすぎないように、画素の数を 600 万までにする
  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  dpr = Math.min(dpr, Math.sqrt(6e6 / (W * H)), maxTex / W, maxTex / H);
  const phone = W < 700;
  const side = phone ? Math.min(W - 32, H * 0.6) : Math.min(H * 0.62, W * 0.5);
  const cy = phone ? Math.max(side / 2 + 64, H * 0.4) : H * 0.44;
  Object.assign(view, { W, H, dpr });
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  view.side = Math.round(side * dpr);
  view.cx = Math.round(canvas.width / 2);
  view.cy = Math.round(cy * dpr);
  ui.style.top = Math.round(cy + side / 2 + 28) + 'px';
  if (renderer) renderer.resize(canvas.width, canvas.height, msaaFor(view.side));
}

// 壁の正方形の一辺（描き先の画素）から、1画素を見る点の数を決める
function msaaFor(sidePx) {
  const grid = renderer && renderer.coarse ? RENDER_GRID / 2 : RENDER_GRID;
  return sidePx < MS_BELOW_PX_PER_CELL * grid ? MS_SAMPLES : 0;
}

// ---------------------------------------------------------------- 状態

const S = {
  dist: 0,
  tilt: 0,
  t: 0, // 混ぜる割合（A から B へ）
  morph: null, // {start, dur, kind}
  intro: 'wait', // wait（板を待つ）→ run（距離が動く）→ done
  introStart: 0,
  plateA: null, // 混ぜる元の板（CPU の写し）。混ぜている途中で次の言葉が来たときに混ぜた板を作り直すため
  plateB: null,
  shown: null, // いま見せている板の数（numbers の1行に出す）
  word: null,
};

const W1 = RENDER_GRID + 1;
const flatPlate = () => new Float32Array(W1 * W1 * 4);

let renderer = null;
try {
  renderer = createRenderer(canvas);
} catch (e) {
  renderer = null;
  console.error(e);
  var rendererError = String(e && e.message ? e.message : e);
}

const frameLog = []; // 続けて描いたコマの間の時間（ミリ秒）。250 ms 以上空いた間は、止まっていた間なので数えない
let lastFrame = 0;
let raf = 0;
function requestFrame() {
  if (!raf && renderer && !contextLost) raf = requestAnimationFrame(frame);
}

let frameCount = 0;
function frame(ts) {
  raf = 0;
  frameCount++;
  const t = clock();
  let more = false;
  // 最初の言葉の組み替わりは、距離が動き始めるまで start が決まらない（その間は描き直さない）
  if (S.morph && Number.isFinite(S.morph.start)) {
    const u = Math.max(0, (t - S.morph.start) / S.morph.dur);
    if (u >= 1) finishMorph();
    else {
      S.t = ease(u);
      more = true;
    }
  }
  if (S.intro === 'run') {
    const u = Math.max(0, (t - S.introStart) / PACE.dist);
    if (u >= 1) {
      S.dist = D0;
      endIntro();
    } else {
      S.dist = ease(u) * D0;
      more = true;
    }
  }
  draw();
  if (lastFrame && ts - lastFrame < 250) {
    frameLog.push(ts - lastFrame);
    if (frameLog.length > 600) frameLog.splice(0, frameLog.length - 600);
    slowCheck();
  }
  lastFrame = ts;
  updateNumbers();
  if (more) requestFrame();
}

// 描くのが遅い端末で、描く網を一度だけ粗くする
let slowChecked = false;
function slowCheck() {
  if (slowChecked || frameLog.length < 30) return;
  const m = median(frameLog.slice(-30));
  if (!(m > SLOW_FRAME_MS)) return;
  slowChecked = true;
  const R = renderer;
  R.setCoarse(true);
  R.info.coarseAtMs = m;
  R.resize(canvas.width, canvas.height, msaaFor(view.side));
  updateDiag();
}

function draw() {
  const R = renderer;
  R.drawLight({ target: R.acc, cx: view.cx, cy: view.cy, side: view.side, dist: S.dist, tilt: S.tilt, t: S.t });
  R.drawTone(R.acc, null);
}

function startMorph(plate, dur, kind) {
  const R = renderer;
  if (S.morph || S.t > 0) {
    const a = S.plateA;
    const b = S.plateB;
    const t = S.t;
    for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t;
    R.upload(0, a);
  }
  S.plateB = plate;
  R.upload(1, plate);
  S.t = 0;
  S.morph = { start: clock(), dur, kind };
  requestFrame();
}

function replaceTarget(plate) {
  S.plateB = plate;
  renderer.upload(1, plate);
  requestFrame();
}

function finishMorph() {
  S.plateA = S.plateB;
  S.plateB = null;
  renderer.swap();
  S.t = 0;
  S.morph = null;
  settleCheck();
}

function setPlateNow(plate) {
  S.plateA = plate;
  S.plateB = null;
  S.t = 0;
  S.morph = null;
  renderer.upload(0, plate);
  requestFrame();
}

function endIntro() {
  if (S.intro === 'done') return;
  S.intro = 'done';
  ui.classList.add('on');
  settleCheck();
}

function startIntroRun() {
  if (S.intro !== 'wait') return;
  S.intro = 'run';
  S.introStart = clock();
  startPendingMorph(S.introStart);
  requestFrame();
}

// 始まりを待っている組み替わりを、時刻 t から始める
function startPendingMorph(t) {
  if (S.morph && !Number.isFinite(S.morph.start)) S.morph.start = t;
}

// ---------------------------------------------------------------- 解く側との受け渡し

let worker = null;
let workerBusy = false;
let job = null; // いま解いている言葉
const jobs = []; // 試験のための記録
let jobSeq = 0;

function spawnWorker() {
  worker = new Worker('./solver.js');
  worker.onmessage = onWorker;
  worker.onerror = (e) => {
    workerBusy = false;
    showError('解く側が止まった: ' + (e.message || ''));
  };
}

function requestWord(word, opts = {}) {
  const t0 = now();
  const id = ++jobSeq;
  let t256, t512;
  try {
    t256 = makeTarget(word, 256, { family: FONT });
    t512 = ONLY256 ? null : makeTarget(word, 512, { family: FONT, supersample: 2 });
  } catch (e) {
    showError('言葉を絵にできない: ' + e.message);
    return null;
  }
  const j = {
    id,
    word,
    intro: !!opts.intro,
    instant: !!opts.instant,
    tCommit: t0,
    targetMs: now() - t0,
    lines: t256.lines,
    target256: TEST ? t256.data.slice() : null,
    targetMean: t256.mean,
    settled: false,
    got512: false,
    expect512: null,
  };
  job = j;
  jobs.push(j);
  if (workerBusy) {
    worker.terminate();
    spawnWorker();
  }
  workerBusy = true;
  const list = [{ n: 256, target: t256.data }];
  const transfer = [t256.data.buffer];
  if (t512) {
    list.push({ n: 512, target: t512.data, onlyIfPrevMs: SOLVE_512_UNDER_MS });
    transfer.push(t512.data.buffer);
  }
  worker.postMessage(
    {
      type: 'solve',
      id,
      jobs: list,
      renderGrid: RENDER_GRID,
      optics: { size: SIZE, distance: D0, solveIndex: N_WAVE[1], n: N_WAVE },
    },
    transfer,
  );
  return j;
}

function onWorker(e) {
  const m = e.data;
  const j = job;
  if (!j || m.id !== j.id) return; // 捨てた言葉の分
  const t = now();
  if (m.type === 'plate') {
    const rec = { solveMs: m.solveMs, prepMs: m.prepMs, maxDepth: m.maxDepth, disp: m.disp, arriveMs: t - j.tCommit };
    if (TEST) rec.height = m.height;
    if (m.n === 256) {
      j.p256 = rec;
      if (j.intro && S.intro !== 'done') {
        if (j.instant) {
          setPlateNow(m.plate);
          S.intro = 'run';
          S.dist = D0;
          endIntro();
        } else {
          // 平らな板のまま待ち、距離が動き始めると同時に、解いた板へ組み替わり始める
          S.plateB = m.plate;
          renderer.upload(1, m.plate);
          S.t = 0;
          S.morph = { start: Infinity, dur: PACE.dist * INTRO_FADE, kind: 'intro' };
          setTimeout(startIntroRun, Math.max(0, PACE.hold - t));
        }
      } else if (j.instant) {
        setPlateNow(m.plate);
      } else {
        startMorph(m.plate, PACE.morph, 'word');
      }
      rec.showMs = now() - j.tCommit; // 言葉が決まってから、光が組み替わり始めるまで
      S.shown = { n: 256, solveMs: m.solveMs, maxDepth: m.maxDepth };
      S.word = j.word;
    } else {
      j.p512 = rec;
      j.got512 = true;
      if (j.instant) setPlateNow(m.plate);
      else if (S.morph && (S.morph.kind === 'word' || S.morph.kind === 'intro')) replaceTarget(m.plate);
      else startMorph(m.plate, PACE.swap, 'swap');
      rec.showMs = now() - j.tCommit;
      S.shown = { n: 512, solveMs: m.solveMs, maxDepth: m.maxDepth };
    }
    updateNumbers(true);
    updateDiag();
  } else if (m.type === 'done') {
    workerBusy = false;
    j.expect512 = j.got512;
    j.workerDone = true;
    settleCheck();
    updateDiag();
  } else if (m.type === 'error') {
    workerBusy = false;
    j.error = m.message;
    j.workerDone = true;
    showError('解けなかった: ' + m.message);
    settleCheck();
  }
}

function settleCheck() {
  const j = job;
  if (!j || j.settled || !j.workerDone) return;
  if (S.morph) return;
  if (j.intro && S.intro !== 'done') return;
  j.settled = true;
  j.settledMs = now() - j.tCommit;
}

// ---------------------------------------------------------------- 文の1行

const fmtInt = (v) => v.toLocaleString('en-US');
// 数の1行は3つに分け、狭い画面では分け目で折り返す（解いた数と時間／深さ／板と壁と材料）
const numParts = [0, 1, 2].map(() => numbersEl.appendChild(document.createElement('span')));
let lastNumbers = '';
function setNumbers(...texts) {
  const s = texts.join('|');
  if (s === lastNumbers) return;
  numParts.forEach((el, i) => {
    el.textContent = texts[i] || '';
    el.hidden = !texts[i];
  });
  lastNumbers = s;
}
function updateNumbers(force) {
  if (force) lastNumbers = '';
  const tail = `板 ${Math.round(SIZE * 1000)} mm 角　壁まで ${Math.round(S.dist * 1000)} mm　${MATERIAL}`;
  if (!S.shown) setNumbers('この端末で解いています', '', tail);
  else {
    const n = S.shown.n;
    setNumbers(`この端末で ${fmtInt(n * n)} 個の未知数を ${(S.shown.solveMs / 1000).toFixed(2)} 秒で解いた`, `最大の深さ ${(S.shown.maxDepth * 1000).toFixed(1)} mm`, tail);
  }
}

function showError(msg) {
  lastNumbers = '';
  setNumbers(msg);
}

function median(a) {
  if (!a.length) return NaN;
  const b = a.slice().sort((x, y) => x - y);
  const h = b.length >> 1;
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
}

function osName() {
  const ua = navigator.userAgent;
  const m = ua.match(/(iPhone OS|CPU OS|Android|Windows NT|Mac OS X) ([\d._]+)/);
  return m ? `${m[1]} ${m[2]}` : '';
}

function updateDiag() {
  if (!DIAG) return;
  const yes = (v) => (v ? '可' : '不可');
  const parts = [];
  if (!renderer) {
    parts.push('WebGL2 不可');
    if (typeof rendererError !== 'undefined') parts.push(rendererError);
  } else {
    const i = renderer.info;
    const j = job;
    const ms = (r) => (r ? (r.solveMs / 1000).toFixed(2) + ' 秒' : '—');
    parts.push('WebGL2 可');
    parts.push(`half_float ${yes(i.half)}　float ${yes(i.float)}　float_blend ${yes(i.floatBlend)}`);
    parts.push(`描き先 ${i.target}　1画素の点 ${i.samples}`);
    parts.push(`描く網 ${i.drawGrid}${i.coarseAtMs ? `（コマ ${i.coarseAtMs.toFixed(1)} ms で粗くした）` : ''}`);
    parts.push(`256 ${ms(j && j.p256)}　512 ${j && j.workerDone && !j.got512 ? '解かず' : ms(j && j.p512)}`);
    const fm = median(frameLog.slice(-60));
    parts.push(`コマ ${isNaN(fm) ? '—' : fm.toFixed(1) + ' ms'}`);
    parts.push(`画素の密度 ${(window.devicePixelRatio || 1).toFixed(2)}（使う ${view.dpr.toFixed(2)}）`);
    parts.push(`画面 ${canvas.width}×${canvas.height}`);
    parts.push(`512 に替えた ${j && j.got512 ? 'はい' : 'いいえ'}`);
    parts.push(`目標 ${j ? j.targetMs.toFixed(0) : '—'} ms`);
    parts.push(i.gpu);
  }
  parts.push(osName());
  diagEl.textContent = parts.join(' ／ ');
}

// ---------------------------------------------------------------- 指と入力

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (drag) return;
  if (document.activeElement === input) input.blur();
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, d0: S.dist, a0: S.tilt };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (_) {}
  if (S.intro !== 'done') {
    S.intro = 'done';
    ui.classList.add('on');
  }
  startPendingMorph(clock());
  hint.classList.add('off');
  e.preventDefault();
  requestFrame();
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  S.dist = clamp(drag.d0 + ((drag.y - e.clientY) / DRAG_PX) * D0, 0, 2 * D0);
  S.tilt = clamp(drag.a0 + (e.clientX - drag.x) / TILT_PX, -TILT_MAX, TILT_MAX);
  e.preventDefault();
  requestFrame();
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  updateDiag();
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
// iPhone の Safari で、壁の上の指でページが動かないように
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

function limitWidth(s) {
  let w = 0;
  let out = '';
  for (const ch of Array.from(s)) {
    w += wordWidth(ch);
    if (w > MAX_WIDTH) break;
    out += ch;
  }
  return out;
}

let composing = false;
let commitTimer = 0;
function scheduleCommit() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitInput, 300);
}
function commitInput() {
  clearTimeout(commitTimer);
  if (composing) return;
  const w = input.value.trim();
  if (!w) return; // 空のときは前の言葉のまま
  if (job && w === job.word) return;
  requestWord(w);
}
function enforceLimit() {
  const v = limitWidth(input.value);
  if (v !== input.value) input.value = v;
}
input.addEventListener('compositionstart', () => {
  composing = true;
  clearTimeout(commitTimer);
});
input.addEventListener('compositionend', () => {
  composing = false;
  enforceLimit();
  scheduleCommit();
});
input.addEventListener('input', (e) => {
  if (composing || e.isComposing) return;
  enforceLimit();
  scheduleCommit();
});
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || composing || e.keyCode === 229) return;
  e.preventDefault();
  enforceLimit();
  commitInput();
  input.blur();
});

// ---------------------------------------------------------------- 始め

let contextLost = false;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  contextLost = true;
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  try {
    const old = renderer;
    renderer = createRenderer(canvas);
    if (!renderer) renderer = old;
    layout();
    if (S.plateA) renderer.upload(0, S.plateA);
    if (S.plateB) renderer.upload(1, S.plateB);
    requestFrame();
  } catch (err) {
    showError('描き直せなかった: ' + err.message);
  }
});

window.addEventListener('resize', () => {
  layout();
  requestFrame();
});

if (DIAG) diagEl.hidden = false;
if (!renderer) {
  document.body.classList.add('nogl');
  showError('このブラウザでは WebGL2 が使えないので、光を描けない');
  updateDiag();
} else {
  layout();
  S.plateA = flatPlate();
  spawnWorker();
  requestFrame();
  updateNumbers(true);
  updateDiag();
  if (!HOLD) requestWord(FIRST_WORD, { intro: true });
}

// ---------------------------------------------------------------- 試験の入口（?test=1 のときだけ）

if (TEST && renderer) {
  const post = async (name, body, headers = {}) => {
    const r = await fetch('/save/' + name, { method: 'POST', body, headers });
    if (!r.ok) throw new Error('保存に失敗: ' + name + ' ' + r.status);
  };
  const flipRows = (src, w, h, ch) => {
    const out = new src.constructor(src.length);
    const row = w * ch;
    for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  };
  // 壁の正方形だけを side×side で描き、画面への直しの前の明るさ（波長3本の平均、平らな板で 1）と画面の値を返す
  const renderSquare = (side, k) => {
    const R = renderer;
    const gl = R.gl;
    // 画面と同じ決め方で、1画素を見る点の数を決める（600 の正方形なら 4 点）。32 bit で何点も見る描き先が作れなければ 16 bit
    const kind = R.info.target === 'RGBA8' ? '8' : R.info.float && R.info.floatBlend ? '32F' : '16F';
    const samples = msaaFor(side);
    let acc = R.makeTarget(side, side, kind, samples);
    if (samples && acc && !acc.samples && kind === '32F') {
      acc.free();
      acc = R.makeTarget(side, side, '16F', samples);
    }
    lastSquare = { kind: acc.kind, samples: acc.samples || 1, drawGrid: R.info.drawGrid };
    const out8 = R.makeTarget(side, side, '8');
    R.drawLight({ target: acc, cx: side / 2, cy: side / 2, side, dist: k * D0, tilt: 0, t: S.t });
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo);
    let E;
    if (kind === '8') {
      const b = new Uint8Array(side * side * 4);
      gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, b);
      E = Float32Array.from(b, (v) => (v / 255) * acc.decode);
    } else {
      E = new Float32Array(side * side * 4);
      gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, E);
    }
    R.drawTone(acc, out8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out8.fbo);
    const px = new Uint8Array(side * side * 4);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    acc.free();
    out8.free();
    const Ef = flipRows(E, side, side, 4);
    const pf = flipRows(px, side, side, 4);
    const mean = new Float32Array(side * side);
    const rgb = new Uint8Array(side * side * 3);
    for (let i = 0; i < side * side; i++) {
      mean[i] = (Ef[4 * i] + Ef[4 * i + 1] + Ef[4 * i + 2]) / 3;
      rgb[3 * i] = pf[4 * i];
      rgb[3 * i + 1] = pf[4 * i + 1];
      rgb[3 * i + 2] = pf[4 * i + 2];
    }
    return { mean, rgb, rgba: Ef };
  };
  let lastSquare = null;
  window.glassTest = {
    // 1コマを描いて GPU が終わるまで待つ時間（1画素を読んで待つ）を n 回測る。手元の GPU の値
    drawCost(n = 60) {
      const gl = renderer.gl;
      const px = new Uint8Array(4);
      const t = [];
      draw();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < n; i++) {
        const t0 = now();
        draw();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        t.push(now() - t0);
      }
      return { n, medianMs: median(t), maxMs: Math.max(...t), samples: renderer.info.samples, drawGrid: renderer.info.drawGrid, canvas: [canvas.width, canvas.height] };
    },
    // 描く網を粗くするか（試験で両方を測るため）
    setCoarse(on) {
      renderer.setCoarse(on);
      renderer.resize(canvas.width, canvas.height, msaaFor(view.side));
      requestFrame();
      return { drawGrid: renderer.info.drawGrid, samples: renderer.info.samples };
    },
    lastSquare() {
      return lastSquare;
    },
    start(word, opts = {}) {
      return requestWord(word || FIRST_WORD, { intro: true, instant: !!opts.instant }) ? true : false;
    },
    // 同じ solver.js をページの本体のスレッドで読み、解く時間を測る。CDP の CPU の絞りは Worker に届かないので、絞った時間はこれで測る
    async solveInline(word) {
      if (typeof window.solve !== 'function') {
        await new Promise((res, rej) => {
          const el = document.createElement('script');
          el.src = './solver.js';
          el.onload = res;
          el.onerror = () => rej(new Error('solver.js を読めない'));
          document.head.appendChild(el);
        });
      }
      const tg = makeTarget(word, 256, { family: FONT });
      const t0 = now();
      const r = window.solve(tg.data, 256, { nGlass: N_WAVE[1], size: SIZE, distance: D0 });
      const t1 = now();
      window.makePlate(r.height, 256, RENDER_GRID, SIZE);
      const t2 = now();
      return { solveMs: t1 - t0, prepMs: t2 - t1, maxDepth: r.stats.maxDepth };
    },
    setWord(word, opts = {}) {
      return !!requestWord(word, { instant: !!opts.instant });
    },
    idle() {
      return S.intro === 'done' && !S.morph && !workerBusy && !!job && job.settled;
    },
    setDistance(k) {
      S.dist = k * D0;
      requestFrame();
    },
    setTilt(deg) {
      S.tilt = deg;
      requestFrame();
    },
    // 動きの時計を ms（ページを開いてからの時刻）に止める。null で戻す
    freeze(ms) {
      frozenAt = ms;
      requestFrame();
    },
    state() {
      return { frames: frameCount, now: now(), dist: S.dist, tilt: S.tilt, t: S.t, intro: S.intro, morph: !!S.morph, word: S.word, shown: S.shown, view: { ...view, canvasW: canvas.width, canvasH: canvas.height } };
    },
    info() {
      return { ...renderer.info, pace: PACE_ID, paces: PACES, nWave: N_WAVE, wavesUm: WAVES_UM, tone: { k: TONE_K, gamma: TONE_GAMMA }, renderGrid: RENDER_GRID };
    },
    jobs() {
      return jobs.map((j) => {
        const strip = (r) => (r ? { solveMs: r.solveMs, prepMs: r.prepMs, maxDepth: r.maxDepth, disp: r.disp, arriveMs: r.arriveMs, showMs: r.showMs } : null);
        return { id: j.id, targetMs: j.targetMs, lines: j.lines.length, targetMean: j.targetMean, settled: j.settled, settledMs: j.settledMs, got512: j.got512, error: j.error || null, p256: strip(j.p256), p512: strip(j.p512) };
      });
    },
    frames: {
      reset() {
        frameLog.length = 0;
      },
      get() {
        return frameLog.slice();
      },
    },
    async saveWord(prefix, ks) {
      const j = job;
      const n = 256;
      await post(`${prefix}_height.bin`, j.p256.height);
      const tg = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) tg[i] = Math.round(clamp(j.target256[i], 0, 1) * 255);
      await post(`${prefix}_target.png`, tg, { 'X-Width': n, 'X-Height': n, 'X-Channels': 1 });
      const side = 600;
      for (const k of ks) {
        const r = renderSquare(side, k);
        await post(`${prefix}_render_${k}.f32`, r.mean);
        await post(`${prefix}_wall_${k}.png`, r.rgb, { 'X-Width': side, 'X-Height': side, 'X-Channels': 3 });
      }
      return true;
    },
    // 画面のうち、端末の画素で (x, y, w, h)（上から）を切り出し、scale 倍にして保存する
    async saveScreen(name, x, y, w, h, scale) {
      draw();
      const gl = renderer.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(x, canvas.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const f = flipRows(px, w, h, 4);
      const W = w * scale;
      const H = h * scale;
      const rgb = new Uint8Array(W * H * 3);
      for (let j = 0; j < H; j++) {
        const sj = Math.floor(j / scale);
        for (let i = 0; i < W; i++) {
          const si = Math.floor(i / scale);
          const s = 4 * (sj * w + si);
          const d = 3 * (j * W + i);
          rgb[d] = f[s];
          rgb[d + 1] = f[s + 1];
          rgb[d + 2] = f[s + 2];
        }
      }
      await post(name, rgb, { 'X-Width': W, 'X-Height': H, 'X-Channels': 3 });
      return { W, H };
    },
    // 設計の距離の壁の正方形で、目標の字の所と地の所の画面の値（8 bit）の中央値
    toneCheck(k = 1) {
      const side = 600;
      const r = renderSquare(side, k);
      const n = 256;
      const tgt = job.target256;
      const fg = [], bg = [];
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const v = tgt[Math.floor((y * n) / side) * n + Math.floor((x * n) / side)];
          const g = r.rgb[3 * (y * side + x) + 1];
          if (v > 0.98) fg.push(g);
          else if (v < 0.121) bg.push(g);
        }
      }
      return { letters: median(fg), background: median(bg), lettersCount: fg.length, backgroundCount: bg.length };
    },
  };
}
