// 組み立ての道具（tools/build.mjs）が作った物。手で直さず、元を直して作り直す。
// 中身: 解く側（solve.js）と、描く板の補い（src/worker_tail.js）。import を使わない Worker の1ファイル

// 一枚のガラスの解く側。依存なし。DOM を使わないので、ブラウザの本体・Web Worker・Node で同じファイルが動く。
//
// 目標の明るさ（n×n、行ごと、上の行から）から、板の裏の面の高さを解く。
//   1. 網の動かし: 壁の上の一様な網の各マスに、板の上のどれだけの面積の光を集めるかを決める。
//      板の上の点の位置を S(u) = u + ∇χ(u) と書き、χ を余弦変換のポアソン方程式の直接解法で直していく（粗い網から細かい網へ）
//   2. 引き直し: 板の上の一様な網の各点が、壁のどこへ行くかを、動かした網の三角形から読む
//   3. 必要な傾き: 板の点から壁の点へ光を曲げる面の傾きを、スネルの法則（近似なし）で出す
//   4. 板の高さ: 傾きに最小二乗で合う高さを、もう一度ポアソン方程式を余弦変換で直接解いて出す。
//      壁までの距離を d − h に直して 3 と 4 を数回くり返す
//
// 座標: 板も壁も同じ正方形（一辺 size）。x は右、y は下（絵の行の向き）、z は光の進む向き。
// 板の表（光の入る側）は平ら、裏の面が z = h(x, y)（h ≤ 0、いちばん高い所が 0）。壁は z = distance。

const OPTICS = Object.freeze({
  size: 0.1, // 板の一辺（m）
  distance: 0.2, // 板の裏の面（h = 0）から壁まで（m）
  nGlass: 1.49, // 板の屈折率
  nAir: 1.0,
  light: [0, 0, 1], // 板の外での光の向き（既定は板に垂直な平行光）
});

const SOLVE_DEFAULTS = Object.freeze({
  coarsest: 32, // いちばん粗い網のマスの数
  iters: [40, 24, 16, 16, 10], // 網の大きさ 32, 64, 128, 256, 512 の段ごとの回数の上限
  kappa: 1, // 前処理の固有値の下限（5点のラプラシアンの固有値に対する割合）
  minCross: 1e-4, // 網の四角が潰れたとみなす角の外積（一様なマスの面積が 1 の単位）
  tol: 0.01, // 面積の差の最大がこれより小さければその段を打ち切る
  heightIters: 3,
  scale: 'sqrt', // 面積の差を割る値: sqrt（面積の平方根）、coef（網の伸びの平均）、one（割らない）
  upsample: 'spectral', // 段の間の引き伸ばし: spectral（余弦変換）、bilinear（双線形）
  accept: 1, // 一歩で面積の差（二乗平均）がこの倍率より大きくなる歩幅は取らない
});

// ---------------------------------------------------------------- FFT と余弦変換

const plans = new Map();

function plan(N) {
  let p = plans.get(N);
  if (p) return p;
  const bits = Math.round(Math.log2(N));
  if (N < 2 || 1 << bits !== N) throw new Error(`FFT の長さは 2 の累乗: ${N}`);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(N >> 1);
  const sin = new Float64Array(N >> 1);
  for (let i = 0; i < N >> 1; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N);
    sin[i] = Math.sin((2 * Math.PI * i) / N);
  }
  // 第2種の余弦変換（Makhoul の並べ替え）で使う e^{-iπk/2N}
  const c2 = new Float64Array(N);
  const s2 = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    c2[k] = Math.cos((Math.PI * k) / (2 * N));
    s2[k] = Math.sin((Math.PI * k) / (2 * N));
  }
  p = { N, rev, cos, sin, c2, s2, re: new Float64Array(N), im: new Float64Array(N) };
  plans.set(N, p);
  return p;
}

// その場で順方向の離散フーリエ変換（e^{-2πijk/N}）
function fft(p, re, im) {
  const { N, rev, cos, sin } = p;
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = start + j;
        const b = a + half;
        const wr = cos[k];
        const wi = -sin[k];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// 第2種の余弦変換 X[k] = Σ x[j] cos(πk(2j+1)/2N) を2本まとめて（実数2本を複素数1本の FFT に詰める）
function dct2Pair(p, x1, x2, o1, o2) {
  const { N, re, im, c2, s2 } = p;
  const h = N >> 1;
  for (let j = 0; j < h; j++) {
    re[j] = x1[2 * j];
    im[j] = x2[2 * j];
    re[N - 1 - j] = x1[2 * j + 1];
    im[N - 1 - j] = x2[2 * j + 1];
  }
  fft(p, re, im);
  for (let k = 0; k < N; k++) {
    const nk = (N - k) & (N - 1);
    const zr = re[k];
    const zi = im[k];
    const wr = re[nk];
    const wi = im[nk];
    const v1r = 0.5 * (zr + wr);
    const v1i = 0.5 * (zi - wi);
    const v2r = 0.5 * (zi + wi);
    const v2i = -0.5 * (zr - wr);
    o1[k] = c2[k] * v1r + s2[k] * v1i;
    o2[k] = c2[k] * v2r + s2[k] * v2i;
  }
}

// dct2Pair のちょうど逆
function idct2Pair(p, X1, X2, o1, o2) {
  const { N, re, im, c2, s2 } = p;
  for (let k = 0; k < N; k++) {
    const y1 = k === 0 ? 0 : X1[N - k];
    const y2 = k === 0 ? 0 : X2[N - k];
    const c = c2[k];
    const s = s2[k];
    const v1r = c * X1[k] + s * y1;
    const v1i = s * X1[k] - c * y1;
    const v2r = c * X2[k] + s * y2;
    const v2i = s * X2[k] - c * y2;
    re[k] = v1r - v2i;
    im[k] = -(v1i + v2r); // 逆変換は共役をとって順変換
  }
  fft(p, re, im);
  const inv = 1 / N;
  const h = N >> 1;
  for (let j = 0; j < h; j++) {
    o1[2 * j] = re[j] * inv;
    o2[2 * j] = -im[j] * inv;
    o1[2 * j + 1] = re[N - 1 - j] * inv;
    o2[2 * j + 1] = -im[N - 1 - j] * inv;
  }
}

// m×m の行ごとの配列に、2次元の第2種の余弦変換（inverse なら逆）をその場で当てる
function dct2D(m, a, inverse) {
  const p = plan(m);
  const f = inverse ? idct2Pair : dct2Pair;
  for (let r = 0; r < m; r += 2) {
    const r1 = a.subarray(r * m, r * m + m);
    const r2 = a.subarray((r + 1) * m, (r + 1) * m + m);
    f(p, r1, r2, r1, r2);
  }
  const c1 = new Float64Array(m);
  const c2 = new Float64Array(m);
  for (let c = 0; c < m; c += 2) {
    for (let r = 0; r < m; r++) {
      c1[r] = a[r * m + c];
      c2[r] = a[r * m + c + 1];
    }
    f(p, c1, c2, c1, c2);
    for (let r = 0; r < m; r++) {
      a[r * m + c] = c1[r];
      a[r * m + c + 1] = c2[r];
    }
  }
}

// 第1種の余弦変換 X[k] = x0/2 + (-1)^k xN/2 + Σ_{j=1}^{N-1} x[j] cos(πjk/N) を2本まとめて（長さ 2N の FFT）
function dct1Pair(p2, N, x1, x2, o1, o2) {
  const { re, im } = p2;
  for (let j = 0; j <= N; j++) {
    re[j] = x1[j];
    im[j] = x2 ? x2[j] : 0;
  }
  for (let j = 1; j < N; j++) {
    re[2 * N - j] = x1[j];
    im[2 * N - j] = x2 ? x2[j] : 0;
  }
  fft(p2, re, im);
  for (let k = 0; k <= N; k++) {
    o1[k] = 0.5 * re[k];
    if (o2) o2[k] = 0.5 * im[k];
  }
}

// (N+1)×(N+1) に2次元の第1種の余弦変換をその場で当てる。2回当てると (N/2)^2 倍で元に戻る
function dct1D2(N, a) {
  const V = N + 1;
  const p2 = plan(2 * N);
  for (let r = 0; r < V; r += 2) {
    const r1 = a.subarray(r * V, r * V + V);
    const r2 = r + 1 < V ? a.subarray((r + 1) * V, (r + 1) * V + V) : null;
    dct1Pair(p2, N, r1, r2, r1, r2);
  }
  const c1 = new Float64Array(V);
  const c2 = new Float64Array(V);
  for (let c = 0; c < V; c += 2) {
    const two = c + 1 < V;
    for (let r = 0; r < V; r++) {
      c1[r] = a[r * V + c];
      if (two) c2[r] = a[r * V + c + 1];
    }
    dct1Pair(p2, N, c1, two ? c2 : null, c1, two ? c2 : null);
    for (let r = 0; r < V; r++) {
      a[r * V + c] = c1[r];
      if (two) a[r * V + c + 1] = c2[r];
    }
  }
}

// ---------------------------------------------------------------- 網の動かし

// χ（マスの中心、m×m）から、壁の一様な網の頂点 (r, c) に対応する板の上の位置（マスの番号の単位）
// 勾配は頂点を囲む4マスの差の平均。外周では外向きの成分を0にする（板の縁の点は縁の上だけを滑る）
function positions(chi, m, X, Y) {
  const V = m + 1;
  for (let r = 0; r <= m; r++) {
    const ra = r > 0 ? r - 1 : 0;
    const rb = r < m ? r : m - 1;
    for (let c = 0; c <= m; c++) {
      let gx = 0;
      let gy = 0;
      if (c > 0 && c < m) {
        gx = 0.5 * (chi[ra * m + c] - chi[ra * m + c - 1] + chi[rb * m + c] - chi[rb * m + c - 1]);
      }
      if (r > 0 && r < m) {
        const ca = c > 0 ? c - 1 : 0;
        const cb = c < m ? c : m - 1;
        gy = 0.5 * (chi[r * m + ca] - chi[(r - 1) * m + ca] + chi[r * m + cb] - chi[(r - 1) * m + cb]);
      }
      const k = r * V + c;
      X[k] = c + gx;
      Y[k] = r + gy;
    }
  }
}

// 各マスの板の上の面積 a と、面積の変わりやすさ coef（面積の1次の変化 ≈ coef·Δδχ）。
// 四角のどれかの角の外積が minCross 以下なら折れ重なりとして false を返す
function measure(X, Y, m, t, a, coef, minCross, out) {
  const V = m + 1;
  let ss = 0;
  let mx = 0;
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      const k = r * V + c;
      const x0 = X[k], y0 = Y[k]; // 左上
      const x1 = X[k + 1], y1 = Y[k + 1]; // 右上
      const x2 = X[k + V + 1], y2 = Y[k + V + 1]; // 右下
      const x3 = X[k + V], y3 = Y[k + V]; // 左下
      const k0 = (x1 - x0) * (y3 - y0) - (y1 - y0) * (x3 - x0);
      const k1 = (x2 - x1) * (y0 - y1) - (y2 - y1) * (x0 - x1);
      const k2 = (x3 - x2) * (y1 - y2) - (y3 - y2) * (x1 - x2);
      const k3 = (x0 - x3) * (y2 - y3) - (y0 - y3) * (x2 - x3);
      if (k0 <= minCross || k1 <= minCross || k2 <= minCross || k3 <= minCross) return false;
      const area = 0.5 * ((x2 - x0) * (y3 - y1) - (y2 - y0) * (x3 - x1));
      const i = r * m + c;
      a[i] = area;
      coef[i] = 0.25 * (x1 - x0 + x2 - x3 + (y3 - y0) + (y2 - y1));
      const d = t[i] - area;
      ss += d * d;
      const ad = d < 0 ? -d : d;
      if (ad > mx) mx = ad;
    }
  }
  out.rms = Math.sqrt(ss / (m * m));
  out.max = mx;
  return true;
}

const eigenCache = new Map();

// 面積の変化の演算子（頂点の勾配の平均 → マスの発散）の固有値の逆数。下限は kappa × 5点のラプラシアンの固有値
function inverseEigen(m, kappa) {
  const key = `${m}:${kappa}`;
  let e = eigenCache.get(key);
  if (e) return e;
  e = new Float64Array(m * m);
  for (let k = 0; k < m; k++) {
    const ck = Math.cos((Math.PI * k) / m);
    for (let l = 0; l < m; l++) {
      if (k === 0 && l === 0) continue;
      const cl = Math.cos((Math.PI * l) / m);
      const l5 = 2 - 2 * ck + (2 - 2 * cl);
      const l9 = ((2 - 2 * ck) * (1 + cl)) / 2 + ((2 - 2 * cl) * (1 + ck)) / 2;
      e[k * m + l] = -1 / Math.max(l9, kappa * l5);
    }
  }
  eigenCache.set(key, e);
  return e;
}

function morphLevel(m, t, chi, maxIters, o, log) {
  const V = m + 1;
  const n2 = m * m;
  let X = new Float64Array(V * V);
  let Y = new Float64Array(V * V);
  let Xt = new Float64Array(V * V);
  let Yt = new Float64Array(V * V);
  let a = new Float64Array(n2);
  let coef = new Float64Array(n2);
  let at = new Float64Array(n2);
  let coeft = new Float64Array(n2);
  const step = new Float64Array(n2);
  const trial = new Float64Array(n2);
  const inv = inverseEigen(m, o.kappa);
  const cur = { rms: 0, max: 0 };
  const nxt = { rms: 0, max: 0 };

  positions(chi, m, X, Y);
  let reset = false;
  let shrink = 0;
  while (!measure(X, Y, m, t, a, coef, o.minCross, cur)) {
    // 上の段から引き継いだ網が折れていたら、動かした量を半分ずつ戻す。8回で平らに戻す
    shrink++;
    if (shrink >= 8) {
      reset = true;
      chi.fill(0);
    } else {
      for (let i = 0; i < n2; i++) chi[i] *= 0.5;
    }
    positions(chi, m, X, Y);
  }
  const level = { reset, shrink, m, iters: 0, halvings: 0, foldRejects: 0, rmsRejects: 0, rms0: cur.rms, max0: cur.max, rms: cur.rms, max: cur.max };
  let s = 1;
  for (let it = 0; it < maxIters; it++) {
    if (cur.max < o.tol) break;
    let mean = 0;
    for (let i = 0; i < n2; i++) {
      const cf = o.scale === 'one' ? 1 : o.scale === 'sqrt' ? Math.sqrt(a[i]) : coef[i];
      const v = (t[i] - a[i]) / Math.max(cf, 0.05);
      step[i] = v;
      mean += v;
    }
    mean /= n2;
    for (let i = 0; i < n2; i++) step[i] -= mean;
    dct2D(m, step, false);
    for (let i = 0; i < n2; i++) step[i] *= inv[i];
    dct2D(m, step, true);

    s = Math.min(1, s * 2);
    let accepted = false;
    for (let tries = 0; tries < 12; tries++) {
      for (let i = 0; i < n2; i++) trial[i] = chi[i] + s * step[i];
      positions(trial, m, Xt, Yt);
      const convex = measure(Xt, Yt, m, t, at, coeft, o.minCross, nxt);
      if (convex && nxt.rms < cur.rms * o.accept) {
        accepted = true;
        break;
      }
      if (convex) level.rmsRejects++;
      else level.foldRejects++;
      s *= 0.5;
      level.halvings++;
    }
    if (!accepted) break;
    chi.set(trial);
    [X, Xt] = [Xt, X];
    [Y, Yt] = [Yt, Y];
    [a, at] = [at, a];
    [coef, coeft] = [coeft, coef];
    cur.rms = nxt.rms;
    cur.max = nxt.max;
    level.iters++;
    if (o.history) (level.hist ||= []).push([+s.toFixed(4), +cur.rms.toFixed(4)]);
  }
  level.rms = cur.rms;
  level.max = cur.max;
  log.push(level);
  return { X, Y };
}

function downsample2(t, m) {
  const h = m >> 1;
  const out = new Float64Array(h * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < h; c++) {
      const i = 2 * r * m + 2 * c;
      out[r * h + c] = 0.25 * (t[i] + t[i + 1] + t[i + m] + t[i + m + 1]);
    }
  }
  return out;
}

// マスの中心の χ を m → 2m に、余弦変換の係数をそのまま移して引き伸ばす（帯域を限った補間）。
// 細かい網で数えると、係数は1次元ごとに2倍、番号の単位が半分になるので値は4倍、合わせて16倍
function upsampleSpectral(chi, m) {
  const M = 2 * m;
  const c = Float64Array.from(chi);
  dct2D(m, c, false);
  const out = new Float64Array(M * M);
  for (let k = 0; k < m; k++) for (let l = 0; l < m; l++) out[k * M + l] = 16 * c[k * m + l];
  dct2D(M, out, true);
  return out;
}

// マスの中心の χ を m → 2m に双線形で引き伸ばす。番号の単位が半分になるので値は4倍
function upsample2(chi, m) {
  const M = 2 * m;
  const out = new Float64Array(M * M);
  for (let R = 0; R < M; R++) {
    let fy = R / 2 - 0.25;
    if (fy < 0) fy = 0;
    if (fy > m - 1) fy = m - 1;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, m - 1);
    const wy = fy - y0;
    for (let C = 0; C < M; C++) {
      let fx = C / 2 - 0.25;
      if (fx < 0) fx = 0;
      if (fx > m - 1) fx = m - 1;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, m - 1);
      const wx = fx - x0;
      const v =
        (1 - wy) * ((1 - wx) * chi[y0 * m + x0] + wx * chi[y0 * m + x1]) +
        wy * ((1 - wx) * chi[y1 * m + x0] + wx * chi[y1 * m + x1]);
      out[R * M + C] = 4 * v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 引き直し

// 動かした網（壁の頂点 (r, c) → 板の上の X, Y）の三角形で、板の上の一様な頂点が壁のどこへ行くかを読む
function invertMesh(n, X, Y) {
  const V = n + 1;
  const Fu = new Float64Array(V * V);
  const Fv = new Float64Array(V * V);
  const best = new Float64Array(V * V).fill(-Infinity);
  const eps = 1e-7;
  const tri = (i0, i1, i2) => {
    const x0 = X[i0], y0 = Y[i0], x1 = X[i1], y1 = Y[i1], x2 = X[i2], y2 = Y[i2];
    const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(den > 0)) return;
    const u0 = i0 % V, v0 = (i0 - u0) / V;
    const u1 = i1 % V, v1 = (i1 - u1) / V;
    const u2 = i2 % V, v2 = (i2 - u2) / V;
    const ix0 = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 1e-9));
    const ix1 = Math.min(n, Math.floor(Math.max(x0, x1, x2) + 1e-9));
    const iy0 = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 1e-9));
    const iy1 = Math.min(n, Math.floor(Math.max(y0, y1, y2) + 1e-9));
    const id = 1 / den;
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        const l1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) * id;
        const l2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) * id;
        const l0 = 1 - l1 - l2;
        const mn = l0 < l1 ? (l0 < l2 ? l0 : l2) : l1 < l2 ? l1 : l2;
        const k = py * V + px;
        if (mn >= -eps && mn > best[k]) {
          best[k] = mn;
          Fu[k] = l0 * u0 + l1 * u1 + l2 * u2;
          Fv[k] = l0 * v0 + l1 * v1 + l2 * v2;
        }
      }
    }
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const k = r * V + c;
      tri(k, k + 1, k + V + 1);
      tri(k, k + V + 1, k + V);
    }
  }
  let missing = 0;
  for (let k = 0; k < V * V; k++) {
    if (best[k] === -Infinity) {
      missing++;
      Fu[k] = k % V;
      Fv[k] = (k - (k % V)) / V;
    }
  }
  return { Fu, Fv, missing };
}

// ---------------------------------------------------------------- 傾きと高さ

// 板の外の光の向き light が、平らな表の面で曲がった後の、ガラスの中の向き
function insideDirection(light, nGlass, nAir) {
  const L = Math.hypot(light[0], light[1], light[2]);
  const lx = light[0] / L, ly = light[1] / L, lz = light[2] / L;
  if (!(lz > 0)) throw new Error('光は +z の向きに進むこと');
  const eta = nAir / nGlass;
  const k = 1 - eta * eta * (1 - lz * lz);
  return [eta * lx, eta * ly, Math.sqrt(k)];
}

// 板の頂点（一様な網）と、その光が行く壁の点から、裏の面の高さを解く
function heightFromMap(n, Fu, Fv, o, log) {
  const V = n + 1;
  const W = o.size;
  const D = o.distance;
  const dx = W / n;
  const n1 = o.nGlass;
  const n2 = o.nAir;
  const [Ix, Iy, Iz] = insideDirection(o.light, n1, n2);
  const h = new Float64Array(V * V);
  const gx = new Float64Array(V * V);
  const gy = new Float64Array(V * V);
  const b = new Float64Array(V * V);
  const lam = new Float64Array(V);
  for (let k = 0; k <= n; k++) lam[k] = 2 - 2 * Math.cos((Math.PI * k) / n);
  for (let it = 0; it < o.heightIters; it++) {
    for (let r = 0; r <= n; r++) {
      for (let c = 0; c <= n; c++) {
        const k = r * V + c;
        let ox = (Fu[k] - c) * dx;
        let oy = (Fv[k] - r) * dx;
        let oz = D - h[k];
        const L = Math.sqrt(ox * ox + oy * oy + oz * oz);
        ox /= L;
        oy /= L;
        oz /= L;
        // 屈折の後の向き o と前の向き I から、面の法線は n1·I − n2·o に平行。法線を (hx, hy, −1) の形に直す
        const den = n1 * Iz - n2 * oz;
        gx[k] = -(n1 * Ix - n2 * ox) / den;
        gy[k] = -(n1 * Iy - n2 * oy) / den;
      }
    }
    // 辺ごとの高さの差の目標 e と、最小二乗の右辺（外周の行と列は2倍。第1種の余弦変換が対角にする形）
    b.fill(0);
    for (let r = 0; r <= n; r++) {
      for (let c = 0; c < n; c++) {
        const k = r * V + c;
        const e = 0.5 * (gx[k] + gx[k + 1]) * dx;
        const w0 = c === 0 ? 2 : 1;
        const w1 = c + 1 === n ? 2 : 1;
        b[k] -= w0 * e;
        b[k + 1] += w1 * e;
      }
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c <= n; c++) {
        const k = r * V + c;
        const e = 0.5 * (gy[k] + gy[k + V]) * dx;
        const w0 = r === 0 ? 2 : 1;
        const w1 = r + 1 === n ? 2 : 1;
        b[k] -= w0 * e;
        b[k + V] += w1 * e;
      }
    }
    // A h = b を解く。A の固有値は λk + λl（λ = 2 − 2cos(πk/n)）
    dct1D2(n, b);
    for (let k = 0; k <= n; k++) {
      for (let l = 0; l <= n; l++) {
        const i = k * V + l;
        b[i] = k === 0 && l === 0 ? 0 : b[i] / (lam[k] + lam[l]);
      }
    }
    dct1D2(n, b);
    const scale = (2 / n) * (2 / n);
    let mx = -Infinity;
    for (let i = 0; i < V * V; i++) {
      b[i] *= scale;
      if (b[i] > mx) mx = b[i];
    }
    for (let i = 0; i < V * V; i++) h[i] = b[i] - mx;
  }
  // 解いた高さの差分と目標の傾きの差（最小二乗で残った分、回転の成分）
  let ss = 0;
  let gs = 0;
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c < n; c++) {
      const k = r * V + c;
      const e = 0.5 * (gx[k] + gx[k + 1]);
      const d = (h[k + 1] - h[k]) / dx - e;
      ss += d * d;
      gs += e * e;
    }
  }
  log.slopeMismatch = Math.sqrt(ss / Math.max(gs, 1e-30));
  return h;
}

// ---------------------------------------------------------------- 入口

function validate(target, n, o) {
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) throw new Error(`網の大きさ n は 2 の累乗: ${n}`);
  if (!target || target.length !== n * n) throw new Error(`目標の長さが n×n でない: ${target && target.length}`);
  if (!(o.size > 0 && o.distance > 0 && o.nGlass > o.nAir && o.nAir > 0)) throw new Error('光学の引数がおかしい');
}

/**
 * 目標の明るさから板の高さを解く。
 * @param {Float32Array|Float64Array} target n×n、行ごと（上の行から）。値は 0 以上の明るさ（相対値でよい）
 * @param {number} n 網のマスの数（2 の累乗）。頂点は (n+1)×(n+1)
 * @param {object} options OPTICS と SOLVE_DEFAULTS の値を上書きする
 * @returns {{height: Float32Array, mesh: Float32Array, stats: object}}
 *   height: 板の頂点 (n+1)×(n+1) の高さ（m、行ごと）
 *   mesh: 板の一様な頂点から光が行く壁の上の位置 (n+1)×(n+1)×2（m、x, y の順、中心が 0、y は下向き）
 */
function solve(target, n, options = {}) {
  const o = { ...OPTICS, ...SOLVE_DEFAULTS, ...options };
  validate(target, n, o);
  const clock = globalThis.performance || Date;
  const t0 = clock.now();

  // 目標を平均 1 に。光を0にはできないので、ごく小さい下限を置く
  let sum = 0;
  for (let i = 0; i < n * n; i++) sum += Math.max(0, target[i]);
  if (!(sum > 0)) throw new Error('目標が真っ黒');
  const mean = sum / (n * n);
  const finest = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) finest[i] = Math.max(Math.max(0, target[i]) / mean, 1e-3);
  let fs = 0;
  for (let i = 0; i < n * n; i++) fs += finest[i];
  for (let i = 0; i < n * n; i++) finest[i] *= (n * n) / fs;

  const pyramid = [{ m: n, t: finest }];
  while (pyramid[0].m > o.coarsest && pyramid[0].m > 2) {
    const { m, t } = pyramid[0];
    pyramid.unshift({ m: m >> 1, t: downsample2(t, m) });
  }
  const levels = [];
  let chi = new Float64Array(pyramid[0].m * pyramid[0].m);
  let mesh = null;
  for (let li = 0; li < pyramid.length; li++) {
    const { m, t } = pyramid[li];
    if (li > 0) chi = o.upsample === 'bilinear' ? upsample2(chi, pyramid[li - 1].m) : upsampleSpectral(chi, pyramid[li - 1].m);
    const idx = Math.max(0, Math.round(Math.log2(m / o.coarsest)));
    const iters = o.iters[Math.min(idx, o.iters.length - 1)];
    mesh = morphLevel(m, t, chi, iters, o, levels);
  }
  const t1 = clock.now();

  const inv = invertMesh(n, mesh.X, mesh.Y);
  const t2 = clock.now();
  const hlog = {};
  const h = heightFromMap(n, inv.Fu, inv.Fv, o, hlog);
  const t3 = clock.now();

  const V = n + 1;
  const dx = o.size / n;
  const half = o.size / 2;
  const height = new Float32Array(V * V);
  const wall = new Float32Array(V * V * 2);
  let minH = 0;
  for (let k = 0; k < V * V; k++) {
    height[k] = h[k];
    if (h[k] < minH) minH = h[k];
    wall[2 * k] = inv.Fu[k] * dx - half;
    wall[2 * k + 1] = inv.Fv[k] * dx - half;
  }
  return {
    height,
    mesh: wall,
    stats: {
      levels,
      missing: inv.missing,
      slopeMismatch: hlog.slopeMismatch,
      maxDepth: -minH,
      ms: { morph: t1 - t0, invert: t2 - t1, height: t3 - t2 },
      ...(o.keepLensMesh ? { lensMesh: mesh } : {}),
    },
  };
}

// ---------------------------------------------------------------- 画面に描く板（ここから下は Worker の中だけで使う）
//
// 解いた高さの頂点 (n+1)×(n+1) から、描く網（M×M のマス、M は n の整数倍）の頂点ごとに
// 高さ h と傾き ∂h/∂x、∂h/∂y を出す。
//
// 傾きは、高さをつないだ曲面を微分して出さず、解いた網の上で両隣の頂点の高さの差（中心差分、縁は2次の片側差分）から出す。
// 解く側は「辺の両端の傾きの平均 × 辺の長さ = 辺の両端の高さの差」に合うように高さを決めているので、
// 頂点の傾きはこの差分で読むのが解いた形に沿う。高さを通る補間の曲面を微分すると、マス1つ分の細かい揺れが強まり、
// 字の縁にマスの間隔の輪の模様が出る（256 の板で目に見える）。
// h、∂h/∂x、∂h/∂y はそれぞれ、頂点の値をそのまま係数にした3次の B スプライン（点を通さず滑らかにつなぐ形）で描く網に補う。
// 2階の微分まで途切れないので、光の集まり方がマスの境で段にならない。
// 縁の外は、内側の3点を通る2次式で延ばしてから補う。

const BS_PAD = 8; // 縁の外に延ばす頂点の数（使うのは1つだが、延ばし方を変えても足りるように余らせる）

// 描く網の頂点 i（0〜M）が、延ばした並びのどこに当たるかと、4つの重み
function bsplineTaps(n, M) {
  const s = M / n;
  const base = new Int32Array(M + 1);
  const w = new Float64Array((M + 1) * 4);
  for (let i = 0; i <= M; i++) {
    const X = i / s + BS_PAD;
    const f = Math.min(Math.floor(X), n + BS_PAD);
    const t = X - f;
    base[i] = f - 1;
    const u = 1 - t;
    w[4 * i] = (u * u * u) / 6;
    w[4 * i + 1] = (3 * t * t * t - 6 * t * t + 4) / 6;
    w[4 * i + 2] = (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6;
    w[4 * i + 3] = (t * t * t) / 6;
  }
  return { base, w };
}

// V×V の並びを、縁の外へ BS_PAD ずつ2次式で延ばした L×L の並びにする
function padQuadratic(a, V) {
  const L = V + 2 * BS_PAD;
  const c = new Float64Array(L * L);
  for (let r = 0; r < V; r++) for (let q = 0; q < V; q++) c[(r + BS_PAD) * L + q + BS_PAD] = a[r * V + q];
  for (let r = BS_PAD; r < BS_PAD + V; r++) {
    const row = r * L;
    for (let j = BS_PAD - 1; j >= 0; j--) c[row + j] = 3 * c[row + j + 1] - 3 * c[row + j + 2] + c[row + j + 3];
    for (let j = BS_PAD + V; j < L; j++) c[row + j] = 3 * c[row + j - 1] - 3 * c[row + j - 2] + c[row + j - 3];
  }
  for (let q = 0; q < L; q++) {
    for (let j = BS_PAD - 1; j >= 0; j--) c[j * L + q] = 3 * c[(j + 1) * L + q] - 3 * c[(j + 2) * L + q] + c[(j + 3) * L + q];
    for (let j = BS_PAD + V; j < L; j++) c[j * L + q] = 3 * c[(j - 1) * L + q] - 3 * c[(j - 2) * L + q] + c[(j - 3) * L + q];
  }
  return c;
}

// 延ばした並び c を描く網に補い、out の channel 番目に書く
function spread(c, L, taps, W1, out, channel) {
  const { base, w } = taps;
  const vx = new Float64Array(L * W1);
  for (let r = 0; r < L; r++) {
    const row = r * L;
    for (let i = 0; i < W1; i++) {
      const b = row + base[i];
      const k = 4 * i;
      vx[r * W1 + i] = w[k] * c[b] + w[k + 1] * c[b + 1] + w[k + 2] * c[b + 2] + w[k + 3] * c[b + 3];
    }
  }
  for (let j = 0; j < W1; j++) {
    const k = 4 * j;
    const w0 = w[k], w1 = w[k + 1], w2 = w[k + 2], w3 = w[k + 3];
    const r0 = base[j] * W1, r1 = r0 + W1, r2 = r1 + W1, r3 = r2 + W1;
    for (let i = 0; i < W1; i++) {
      out[4 * (j * W1 + i) + channel] = w0 * vx[r0 + i] + w1 * vx[r1 + i] + w2 * vx[r2 + i] + w3 * vx[r3 + i];
    }
  }
}

/**
 * @param {Float32Array} height (n+1)×(n+1)、m
 * @param {number} n 解いた網のマスの数
 * @param {number} M 描く網のマスの数（n の整数倍）
 * @param {number} size 板の一辺（m）
 * @returns {Float32Array} (M+1)×(M+1)×4。頂点ごとに h（m）、∂h/∂x、∂h/∂y、0
 */
function makePlate(height, n, M, size) {
  const V = n + 1;
  const L = V + 2 * BS_PAD;
  const cell = size / n;
  const gx = new Float64Array(V * V);
  const gy = new Float64Array(V * V);
  const H = (r, q) => height[r * V + q];
  for (let r = 0; r < V; r++) {
    for (let q = 0; q < V; q++) {
      let sx, sy;
      if (q === 0) sx = (-3 * H(r, 0) + 4 * H(r, 1) - H(r, 2)) / 2;
      else if (q === n) sx = (3 * H(r, n) - 4 * H(r, n - 1) + H(r, n - 2)) / 2;
      else sx = (H(r, q + 1) - H(r, q - 1)) / 2;
      if (r === 0) sy = (-3 * H(0, q) + 4 * H(1, q) - H(2, q)) / 2;
      else if (r === n) sy = (3 * H(n, q) - 4 * H(n - 1, q) + H(n - 2, q)) / 2;
      else sy = (H(r + 1, q) - H(r - 1, q)) / 2;
      gx[r * V + q] = sx / cell;
      gy[r * V + q] = sy / cell;
    }
  }
  const taps = bsplineTaps(n, M);
  const W1 = M + 1;
  const out = new Float32Array(W1 * W1 * 4);
  spread(padQuadratic(height, V), L, taps, W1, out, 0);
  spread(padQuadratic(gx, V), L, taps, W1, out, 1);
  spread(padQuadratic(gy, V), L, taps, W1, out, 2);
  return out;
}

// 描く網の各頂点で、光が壁の上で横へ動く量（緑の波長）と、そこでの赤と青の着く点のずれ（m）
function displacement(plate, M, optics) {
  const W1 = M + 1;
  const size = optics.size;
  const D = optics.distance;
  const dirs = optics.n.map((ng) => insideDirection([0, 0, 1], ng, 1));
  const at = (k, x, y, wv, out) => {
    const h = plate[4 * k], hx = plate[4 * k + 1], hy = plate[4 * k + 2];
    const inv = 1 / Math.sqrt(hx * hx + hy * hy + 1);
    const nx = hx * inv, ny = hy * inv, nz = -inv;
    const [ix, iy, iz] = dirs[wv];
    const eta = optics.n[wv];
    const dd = nx * ix + ny * iy + nz * iz;
    const kk = 1 - eta * eta * (1 - dd * dd);
    if (kk < 0) return false;
    const f = eta * dd + Math.sqrt(kk);
    const tx = eta * ix - f * nx, ty = eta * iy - f * ny, tz = eta * iz - f * nz;
    if (!(tz > 0)) return false;
    const s = (D - h) / tz;
    out[0] = x + s * tx;
    out[1] = y + s * ty;
    return true;
  };
  const pr = [0, 0], pg = [0, 0], pb = [0, 0];
  let maxMove = 0, rbAtMax = 0, maxRB = 0;
  for (let j = 0; j < W1; j++) {
    for (let i = 0; i < W1; i++) {
      const k = j * W1 + i;
      const x = (i / M - 0.5) * size, y = (j / M - 0.5) * size;
      if (!at(k, x, y, 1, pg) || !at(k, x, y, 0, pr) || !at(k, x, y, 2, pb)) continue;
      const move = Math.hypot(pg[0] - x, pg[1] - y);
      const rb = Math.hypot(pr[0] - pb[0], pr[1] - pb[1]);
      if (move > maxMove) {
        maxMove = move;
        rbAtMax = rb;
      }
      if (rb > maxRB) maxRB = rb;
    }
  }
  return { maxMove, redBlueAtMax: rbAtMax, maxRedBlue: maxRB };
}

self.onmessage = (e) => {
  const m = e.data;
  if (!m || m.type !== 'solve') return;
  let prevMs = Infinity;
  let skipped = false;
  try {
    for (const job of m.jobs) {
      if (job.onlyIfPrevMs != null && !(prevMs <= job.onlyIfPrevMs)) {
        skipped = true;
        break;
      }
      const clock = self.performance;
      const t0 = clock.now();
      const res = solve(job.target, job.n, { nGlass: m.optics.solveIndex, size: m.optics.size, distance: m.optics.distance });
      const t1 = clock.now();
      const plate = makePlate(res.height, job.n, m.renderGrid, m.optics.size);
      const disp = displacement(plate, m.renderGrid, m.optics);
      const t2 = clock.now();
      prevMs = t1 - t0;
      self.postMessage(
        {
          type: 'plate',
          id: m.id,
          n: job.n,
          solveMs: t1 - t0,
          prepMs: t2 - t1,
          maxDepth: res.stats.maxDepth,
          missing: res.stats.missing,
          height: res.height,
          plate,
          disp,
        },
        [res.height.buffer, plate.buffer],
      );
    }
    self.postMessage({ type: 'done', id: m.id, skipped });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
