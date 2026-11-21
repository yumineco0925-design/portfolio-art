// stats.js — 包含係数を出すための t 分布と正規分布。外の表もライブラリも使わない。
//
// GUM（JCGM 100:2008）G.3 と G.4 は、有効自由度 ν_eff の t 分布の分位点 t_p(ν_eff) を
// 包含係数 k にする。表 G.2 は小数2桁までしか無いので、ここでは不完全ベータ関数から
// 累積分布を作り、分位点を二分法で解く。整数の自由度は Abramowitz & Stegun 26.7.3・26.7.4 の
// 有限の級数でも計算でき、試験で両者を突き合わせる。

const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x)（x > 0）。Lanczos の近似（g = 7, 9項）。 */
export function lnGamma(x) {
  if (!(x > 0)) throw new RangeError('lnGamma: x > 0 が要る');
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// 不完全ベータ関数の連分数（修正 Lentz 法）
function betaContinuedFraction(a, b, x) {
  const MAXIT = 500, EPS = 1e-16, TINY = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  throw new Error('不完全ベータ関数の連分数が収束しない');
}

/** 正則化不完全ベータ関数 I_x(a, b)。 */
export function regIncBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

// 正則化不完全ガンマ関数 Q(a, x) = Γ(a, x)/Γ(a)。正規分布の裾に使う（erfc(x) = Q(1/2, x²)）。
function regIncGammaQ(a, x) {
  if (x <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    // 級数で P を出して 1 から引く
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 1000; n++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-17) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // 連分数（修正 Lentz 法）
  const TINY = 1e-300;
  let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** 標準正規分布の上側確率 1 − Φ(z)。 */
export function normalUpper(z) {
  if (z < 0) return 1 - normalUpper(-z);
  return 0.5 * regIncGammaQ(0.5, (z * z) / 2);
}

/** 標準正規分布の累積分布 Φ(z)。 */
export function normalCdf(z) {
  return 1 - normalUpper(z);
}

/** 上側確率が alpha になる z（0 < alpha < 1）。 */
export function normalUpperQuantile(alpha) {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('alpha は 0 と 1 の間');
  if (alpha > 0.5) return -normalUpperQuantile(1 - alpha);
  return bisectDecreasing((z) => normalUpper(z), alpha);
}

// 1e7 を超える自由度は正規分布とみなす（不完全ベータの ln Γ の桁落ちを避ける。t と正規の差は 1e-8 未満）
const isInfiniteDof = (nu) => nu === Infinity || nu > 1e7;

/** t 分布（自由度 nu）の上側確率 P(T > t)。nu は正の実数か Infinity。 */
export function tUpper(t, nu) {
  if (!(nu > 0)) throw new RangeError('自由度は正');
  if (isInfiniteDof(nu)) return normalUpper(t);
  if (t < 0) return 1 - tUpper(-t, nu);
  const x = nu / (nu + t * t);
  return 0.5 * regIncBeta(x, nu / 2, 0.5);
}

/** t 分布の累積分布 P(T ≤ t)。 */
export function tCdf(t, nu) {
  return 1 - tUpper(t, nu);
}

/**
 * 整数の自由度の累積分布を Abramowitz & Stegun 26.7.3（偶数）・26.7.4（奇数）の
 * 有限の級数で出す。不完全ベータ関数とは別の道筋なので、試験の照合に使う。
 */
export function tCdfIntegerSeries(t, nu) {
  if (!Number.isInteger(nu) || nu < 1) throw new RangeError('自由度は正の整数');
  const theta = Math.atan(t / Math.sqrt(nu));
  const s = Math.sin(theta), c = Math.cos(theta), c2 = c * c;
  let A;
  if (nu % 2 === 0) {
    let term = 1, sum = 1;
    for (let j = 2; j <= nu - 2; j += 2) { term *= ((j - 1) / j) * c2; sum += term; }
    A = s * sum;
  } else if (nu === 1) {
    A = (2 * theta) / Math.PI;
  } else {
    let term = c, sum = c;
    for (let j = 3; j <= nu - 2; j += 2) { term *= ((j - 1) / j) * c2; sum += term; }
    A = (2 / Math.PI) * (theta + s * sum);
  }
  return 0.5 * (1 + A);
}

// 単調に減る関数 f が target を取る点を [0, ∞) で二分法で解く
function bisectDecreasing(f, target) {
  let lo = 0, hi = 1;
  while (f(hi) > target) {
    lo = hi; hi *= 2;
    if (hi > 1e12) throw new Error('分位点の範囲が見つからない');
  }
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    if (f(mid) > target) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** 上側確率が alpha になる t（自由度 nu）。 */
export function tUpperQuantile(alpha, nu) {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('alpha は 0 と 1 の間');
  if (isInfiniteDof(nu)) return normalUpperQuantile(alpha);
  if (alpha > 0.5) return -tUpperQuantile(1 - alpha, nu);
  return bisectDecreasing((t) => tUpper(t, nu), alpha);
}

/**
 * 包含確率 p（両側）の包含係数 k = t_p(ν)（GUM G.3.4 式 G.1c, 表 G.2）。
 * 例: p = 0.9545, ν = ∞ → 2.000、p = 0.95, ν = 9 → 2.262。
 */
export function coverageFactor(p, nu) {
  if (!(p > 0 && p < 1)) throw new RangeError('包含確率は 0 と 1 の間');
  return tUpperQuantile((1 - p) / 2, nu);
}
