// gum.js — 持ち込まれた一秒の不確かさを GUM（JCGM 100:2008）の手順で評価する。
//
// 測定量 Y: 押していた長さ（物理的に押し下げてから離すまで。2回押しなら1回目から2回目まで）
//
// 測定の式（1回の場合）
//   Y = (t離 − t押) − (e離 − e押) − (ε離 − ε押)
//     t押, t離  押した・離した時の event.timeStamp（観測値）
//     e押, e離  時計の目量による丸めの誤差（推定値 0）
//     ε押, ε離  入力機器の照会の位相のうち、押す時と離す時に共通でない分（推定値 0）
//
// 相関の扱い（GUM 5.2）: 機器からブラウザまでの遅れ λ は、押す時も離す時も同じ経路を通る。
//   λ押 = L0 + ε押、λ離 = L0 + ε離 と分けると、λ押 と λ離 の相関係数は
//   r = u²(L0) / (u²(L0) + u²(ε)) になり、式 (13) で差を取ると L0 の寄与は
//   u²(L0) + u²(L0) − 2·u²(L0) = 0 で消える。共通の L0 を独立な入力に分けて書いても（F.1.2.3）
//   感度係数は ∂Y/∂L0 = −1 + 1 = 0。どちらの書き方でも、残るのは ε の分だけで、内訳には ε だけを入れる。
//   L0 の大きさは分からないが、結果はその値によらない（試験で確かめる）。
//
// 内訳に入れない物（押していた長さの測定に入らないため）
//   画面の書き換えの周期: 時刻は入力のイベントの時刻で、書き換えを待たない
//   処理が走るまでの遅れ: event.timeStamp で取るので差に入らない
// 評価できない物（数字で埋めず、票にそう書く）
//   端末の時計の周波数の偏り: 比べる標準器が無い
//   押す時と離す時の遅れの差: 機器の中の処理で、ブラウザから測れない（2回押しは同じ動きの2回なので生じない）
//   読み上げソフトの処理の揺れ: 2回押しを読み上げソフトから受けたとき

import { coverageFactor, normalCdf } from './stats.js';

/** 包含確率。2σ の正規の確率（2Φ(2) − 1 = 0.9545）で、ν_eff = ∞ のとき k = 2.00 になる（表 G.2 の 95.45 の列）。 */
export const COVERAGE_P = 2 * normalCdf(2) - 1;

/**
 * 端末から測れない物に置く仮定（GUM 4.3.1 の「経験や一般の知識」による B 型の評価）。
 * reliability は G.4.2 の Δu/u。0.5 は「標準不確かさが半分ほど違っていてもおかしくない」で、
 * 式 G.3 の ν ≈ ½ (Δu/u)⁻² から自由度 2 になる。
 */
export const ASSUMED = Object.freeze({
  scanPeriodMs: Object.freeze({
    keyboard: 8,          // USB の照会 125 Hz。キーボードの照会の周期はブラウザから読めない
    mouse: 8,             // 位置の報告が測れなかったとき
    pen: 8,
    touch: 1000 / 60,     // 指の読み取り 60 Hz。報告が測れなかったとき
    activation: 8,        // 読み上げソフト経由。下のキーボードの照会だけを置く
  }),
  fallbackTickMs: 100,    // 目量が測れなかったときに置く粗めの値
  reliability: 0.5,
});

const SQRT3 = Math.sqrt(3);

/** G.4.2 式 G.3: 相対の信頼性 Δu/u から自由度。 */
export const dofFromReliability = (R) => 1 / (2 * R * R);

/**
 * 合成標準不確かさ（GUM 5.1.2 式 (10)、相関があれば 5.2.2 式 (13)）。
 * rows: [{ c, u }]、correlations: [{ i, j, r }]
 */
export function combine(rows, correlations = []) {
  let sum = 0;
  for (const { c, u } of rows) sum += (c * u) ** 2;
  for (const { i, j, r } of correlations) sum += 2 * rows[i].c * rows[j].c * rows[i].u * rows[j].u * r;
  if (sum < 0 && sum > -1e-18) sum = 0;
  return Math.sqrt(sum);
}

/**
 * Welch–Satterthwaite の有効自由度（GUM G.4.1 式 G.2b）。入力は互いに独立であること。
 * rows の各行は寄与 u_i(y) = |c_i|·u(x_i) を uiMs に持つ。
 */
export function welchSatterthwaite(rows, uc) {
  let denom = 0;
  for (const row of rows) {
    const ui = row.uiMs;
    if (ui > 0 && Number.isFinite(row.nu)) denom += ui ** 4 / row.nu;
  }
  if (denom === 0) return Infinity;
  return uc ** 4 / denom;
}

/** 有効数字 sig 桁に四捨五入（GUM 7.2.6: 不確かさは多くとも2桁）。value と小数の桁数を返す。 */
export function roundUncertainty(x, sig = 2) {
  if (!(x > 0) || !Number.isFinite(x)) return { value: x, decimals: 0, text: String(x) };
  let decimals = sig - 1 - Math.floor(Math.log10(x));
  let m = x * 10 ** decimals;
  if (m >= 10 ** sig - 1e-9) { decimals -= 1; m = x * 10 ** decimals; }
  else if (m < 10 ** (sig - 1) - 1e-9) { decimals += 1; m = x * 10 ** decimals; }
  let mi = Math.floor(m + 0.5 + 1e-9);
  if (mi >= 10 ** sig) { mi /= 10; decimals -= 1; }
  const value = decimals >= 0 ? mi / 10 ** decimals : mi * 10 ** -decimals;
  const d = Math.max(decimals, 0);
  return { value, decimals: d, text: value.toFixed(d) };
}

/** 値を不確かさの桁に合わせて丸める（7.2.6）。四捨五入、0.5 は 0 から遠い側へ。 */
export function roundToDecimals(y, decimals) {
  const f = 10 ** decimals;
  const v = (Math.sign(y) * Math.floor(Math.abs(y) * f + 0.5 + 1e-9)) / f;
  return { value: v, text: v.toFixed(decimals) };
}

function quantizationModel(clock, assumed) {
  const ticks = [clock?.perfTick, clock?.eventTick].filter((t) => t?.ok);
  if (ticks.length) {
    // 粗い方の目量を使い、揺らぎの判定もその時計の物を使う（同じなら performance.now の方。試料が多い）
    const coarse = ticks.reduce((a, b) => (b.tickMs > a.tickMs ? b : a));
    const r = coarse.tickMs;
    const jitter = coarse.jitter ?? null;
    // 矩形分布（4.3.7、F.2.2.1）。揺らぎの無い丸めなら誤差は1目量の幅に収まり半幅 r/2。
    // 揺らぎがある、または判定できないときは、誤差の範囲が ±r まで広がるので半幅 r とする。
    return {
      tickMs: r, jitter,
      halfWidthMs: jitter === false ? r / 2 : r,
      nu: Infinity,
      source: 'measured',
      basis: jitter === false ? '目量の丸め（揺らぎなし）' : jitter === true ? '目量の丸め（目量の内側の揺らぎあり）' : '目量の丸め（揺らぎは判定できず、広い側）',
    };
  }
  const r = assumed.fallbackTickMs;
  return {
    tickMs: r, jitter: null, halfWidthMs: r,
    nu: dofFromReliability(assumed.reliability),
    source: 'assumed',
    basis: '目量を測れなかったので粗めの値を置いた',
  };
}

function scanModel(input, report, assumed) {
  if ((input === 'mouse' || input === 'pen' || input === 'touch') && report?.ok) {
    return { periodMs: report.periodMs, nu: Infinity, source: 'measured', basis: `位置の報告 ${report.samples} 回の間隔の中央値` };
  }
  const periodMs = assumed.scanPeriodMs[input] ?? assumed.scanPeriodMs.keyboard;
  return { periodMs, nu: dofFromReliability(assumed.reliability), source: 'assumed', basis: '照会の周期を仮定（ブラウザから読めない）' };
}

function rectRow(fields) {
  const u = fields.halfWidthMs / SQRT3;
  return { type: 'B', distribution: '矩形', divisor: SQRT3, divisorText: '√3', estimateMs: 0, ...fields, uMs: u, uiMs: Math.abs(fields.c) * u };
}

const STAMP = { press: '押', release: '離' };
const sampleStdev = (xs) => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/**
 * 不確かさの評価。
 * @param {object} args
 *   holds: hold.js の結果（ok: true の物）の配列。1件なら1回の押しを、2件以上なら平均を測定量にする
 *   clock: measure.js の結果
 *   assumed: ASSUMED を部分的に差し替える
 *   coverage: 包含確率（既定 COVERAGE_P）
 *   dofPolicy: 'truncate'（G.4.1: 有効自由度を下の整数に切り捨てる）| 'exact'
 */
export function evaluate({ holds, clock, assumed: override = {}, coverage = COVERAGE_P, dofPolicy = 'truncate' }) {
  if (!Array.isArray(holds) || holds.length === 0) throw new TypeError('holds が要る');
  for (const h of holds) {
    if (!h?.ok || !Number.isFinite(h.durationMs)) throw new TypeError('測れた押し（ok: true）だけを渡す');
  }
  const assumed = {
    ...ASSUMED, ...override,
    scanPeriodMs: { ...ASSUMED.scanPeriodMs, ...(override.scanPeriodMs ?? {}) },
  };
  const n = holds.length;
  const q = quantizationModel(clock, assumed);
  const rows = [];
  const notEvaluated = [{ name: '端末の時計の周波数の偏り', reason: '比べる標準器が無い' }];

  const quantRows = (suffix = '') => [
    rectRow({ symbol: 'e押', name: `押した時刻の丸め${suffix}`, tickMs: q.tickMs, halfWidthMs: q.halfWidthMs, c: +1, nu: q.nu, source: q.source, basis: `${q.basis}。目量 ${q.tickMs} ms`, clause: 'F.2.2.1, 4.3.7' }),
    rectRow({ symbol: 'e離', name: `離した時刻の丸め${suffix}`, tickMs: q.tickMs, halfWidthMs: q.halfWidthMs, c: -1, nu: q.nu, source: q.source, basis: `${q.basis}。目量 ${q.tickMs} ms`, clause: 'F.2.2.1, 4.3.7' }),
  ];

  let estimateMs, model;
  const modes = new Set(holds.map((h) => h.mode));
  const inputsUsed = new Set(holds.flatMap((h) => [h.input.press, h.input.release]));

  if (n === 1) {
    const h = holds[0];
    estimateMs = h.durationMs;
    model = 'Y = (t離 − t押) − (e離 − e押) − (ε離 − ε押)';
    rows.push(...quantRows());
    for (const which of ['press', 'release']) {
      const input = h.input[which];
      const s = scanModel(input, h.pointerReport?.[which], assumed);
      rows.push(rectRow({
        symbol: `ε${STAMP[which]}`,
        name: `${which === 'press' ? '押した' : '離した'}時の照会の位相（共通の遅れを除いた残り）`,
        halfWidthMs: s.periodMs / 2,
        c: which === 'press' ? +1 : -1,
        nu: s.nu,
        source: s.source,
        basis: `${s.basis}。周期 ${Number(s.periodMs.toPrecision(4))} ms、入力 ${input}`,
        clause: '4.3.7, 5.2.2, F.1.2.3',
      }));
    }
  } else {
    // 繰り返しの A 型（4.2.1〜4.2.3）。照会の位相の揺れは押すたびに変わり、ばらつきに既に入っているので
    // 別に足さない（4.3.10）。目量の丸めは、繰り返しの値が目量より細かく散らないことがあるので
    // 1回分をそのまま足す（F.2.2.1）。
    const xs = holds.map((h) => h.durationMs);
    estimateMs = xs.reduce((s, x) => s + x, 0) / n;
    const s = sampleStdev(xs);
    model = 'Y = x̄ − (e離 − e押)、x̄ は n 回の押していた長さの平均';
    rows.push({
      symbol: 'x̄', name: `繰り返しのばらつき（${n} 回）`, type: 'A', distribution: 't',
      estimateMs, sMs: s, n, divisor: Math.sqrt(n), divisorText: `√${n}`,
      halfWidthMs: null, uMs: s / Math.sqrt(n), c: 1, uiMs: s / Math.sqrt(n), nu: n - 1,
      source: 'measured', basis: `実験標準偏差 s = ${Number(s.toPrecision(4))} ms`, clause: '4.2.1, 4.2.2, 4.2.3',
    });
    rows.push(...quantRows('（1回分）'));
  }

  if (modes.has('hold')) notEvaluated.push({ name: '押す時と離す時の遅れの差', reason: '機器の中の処理で、ブラウザから測れない' });
  if (inputsUsed.has('activation')) notEvaluated.push({ name: '読み上げソフトの処理の揺れ', reason: 'ブラウザから測れない' });

  const uc = combine(rows.map((r) => ({ c: r.c, u: r.uMs })));
  const nuEff = welchSatterthwaite(rows, uc);
  const nuUsed = dofPolicy === 'truncate' && Number.isFinite(nuEff) ? Math.max(1, Math.floor(nuEff + 1e-9)) : nuEff;
  const k = coverageFactor(coverage, nuUsed);
  const U = k * uc;

  const Us = roundUncertainty(U / 1000);
  const ys = roundToDecimals(estimateMs / 1000, Us.decimals);
  const ucText = roundUncertainty(uc).text;
  const kText = k.toFixed(2);
  const nuText = Number.isFinite(nuEff) ? nuEff.toFixed(1) : '∞';
  const nuUsedText = Number.isFinite(nuUsed) ? String(nuUsed) : '∞';

  return {
    measurand: n === 1 ? '押していた長さ' : `押していた長さの平均（${n} 回）`,
    model,
    n,
    estimateMs,
    rows,
    notEvaluated,
    ucMs: uc,
    nuEff,
    nuUsed,
    dofPolicy,
    coverage,
    k,
    UMs: U,
    display: {
      y: ys.text, U: Us.text, k: kText, uc: ucText, nuEff: nuText, nuUsed: nuUsedText,
      decimals: Us.decimals,
      line: `${ys.text} s ± ${Us.text} s（k = ${kText}）`,
    },
    statement:
      `Y = (${ys.text} ± ${Us.text}) s。± の後の数は拡張不確かさ U = k·u_c で、合成標準不確かさ u_c = ${ucText} ms と、` +
      `有効自由度 ν_eff = ${nuText}${dofPolicy === 'truncate' && Number.isFinite(nuEff) ? `（切り捨てて ${nuUsedText}）` : ''} の t 分布による包含係数 k = ${kText} から出した。` +
      `この区間は約 95 %（95.45 %）の信頼の水準を持つと見積もった。` +
      `評価できない物: ${notEvaluated.map((x) => x.name).join('、')}。`,
    clauses: { combine: '5.1.2', correlation: '5.2.2, F.1.2.3', dof: 'G.4.1, G.4.2', coverage: '6.2.1, G.3.4', rounding: '7.2.6', report: '7.2.4' },
  };
}
