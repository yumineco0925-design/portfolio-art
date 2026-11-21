// decide.js — その日の公差に対する合否。JCGM 106:2012（適合性評価における測定の不確かさの役割）の考え方による。
//
// 決め方
//   公差の区間 [T_L, T_U] は、名目 1.000 s と、その日の公差の半幅から作る。
//   守りの幅 w は拡張不確かさ U と同じにする（106 の守られた受け入れ guarded acceptance で、w = U とする例）。
//   合格        y が受け入れの区間 [T_L + w, T_U − w] の中（不確かさの幅ごと公差の中）
//   不合格      y が [T_L − w, T_U + w] の外（不確かさの幅ごと公差の外。106 の守られた棄却 guarded rejection）
//   判定できない 上のどちらでもない（不確かさの幅が公差の境をまたぐ）
//   106 の決定の規則は受け入れか棄却かの2つで、ここでは守られた受け入れと守られた棄却を両方当て、
//   どちらの規則でも決まらない帯を「判定できない」とした。
//   U が公差の半幅より大きいと受け入れの区間は空になり、その端末では合格が出ない。
//
// 根拠: w = U で合格にすると、近い方の境の外にある確率は、測定量の分布を有効自由度 ν の
//   t 分布とみなして、片側 (1 − p)/2 = 2.3 % を超えない（p = 95.45 %）。反対側の境も近いときは
//   両方の和になるので、適合の確率 p_c（106 の conformance probability）を別に出して票に載せる。
//   p_c と測定の能力の指数 C_m = (T_U − T_L)/(4u)（106 の measurement capability index）は、判定には使わない。
//   判定は丸める前の y と U で行う。
//   106 の節の番号は原典で確かめていないので書かない。

import { tCdf } from './stats.js';
import { roundToDecimals } from './gum.js';

export const NOMINAL_MS = 1000;
export const DEFAULT_TOLERANCE = Object.freeze({ nominalMs: NOMINAL_MS, halfWidthMs: 50, grade: '三級' });
export const CERTIFICATE_VALIDITY_MS = 1000;

export const VERDICT_LABELS = Object.freeze({ pass: '合格', fail: '不合格', indeterminate: '判定できない' });

/** 適合の確率 p_c = P(T_L ≤ Y ≤ T_U)。Y の分布は y を中心、u を尺度、自由度 ν の t 分布。 */
export function conformanceProbability(y, u, nu, TL, TU) {
  if (!(u > 0)) return y >= TL && y <= TU ? 1 : 0;
  return tCdf((TU - y) / u, nu) - tCdf((TL - y) / u, nu);
}

/**
 * @param {object} result gum.evaluate の結果
 * @param {object} tolerance { nominalMs, halfWidthMs, grade? }
 * @param {object} options { issuedAtEpochMs?, guardFactor? }
 */
export function decide(result, tolerance = DEFAULT_TOLERANCE, options = {}) {
  const y = result.estimateMs;
  const u = result.ucMs;
  const U = result.UMs;
  const nu = result.nuUsed;
  const TL = tolerance.nominalMs - tolerance.halfWidthMs;
  const TU = tolerance.nominalMs + tolerance.halfWidthMs;
  const w = U * (options.guardFactor ?? 1);

  const acceptance = { lowerMs: TL + w, upperMs: TU - w };
  acceptance.empty = acceptance.lowerMs > acceptance.upperMs;
  const rejection = { belowMs: TL - w, aboveMs: TU + w };

  let verdict;
  if (!acceptance.empty && y >= acceptance.lowerMs && y <= acceptance.upperMs) verdict = 'pass';
  else if (y < rejection.belowMs || y > rejection.aboveMs) verdict = 'fail';
  else verdict = 'indeterminate';

  const pc = conformanceProbability(y, u, nu, TL, TU);
  const Cm = u > 0 ? (TU - TL) / (4 * u) : Infinity;

  const decision = {
    verdict,
    label: VERDICT_LABELS[verdict],
    tolerance: {
      nominalMs: tolerance.nominalMs, halfWidthMs: tolerance.halfWidthMs, grade: tolerance.grade ?? null,
      lowerMs: TL, upperMs: TU,
      // 公差は定めた値（測った値ではない）なので、ms の整数が出る小数 3 桁で書く
      text: `${roundToDecimals(tolerance.nominalMs / 1000, 3).text} s ± ${roundToDecimals(tolerance.halfWidthMs / 1000, 3).text} s`,
    },
    guardBandMs: w,
    acceptance,
    rejection,
    pc,
    Cm,
    display: {
      pc: `${(pc * 100).toFixed(1)} %`,
      Cm: Number.isFinite(Cm) ? Cm.toFixed(2) : '∞',
    },
    certificate: null,
  };

  if (verdict === 'pass') {
    const issued = options.issuedAtEpochMs ?? Date.now();
    decision.certificate = {
      issuedAtEpochMs: issued,
      expiresAtEpochMs: issued + CERTIFICATE_VALIDITY_MS,
      validityMs: CERTIFICATE_VALIDITY_MS,
      serial: certificateSerial(issued),
    };
  }
  return decision;
}

/** 合格証が今も有効か。有効期限は発行から 1 秒。 */
export function isCertificateValid(certificate, nowEpochMs = Date.now()) {
  return Boolean(certificate) && nowEpochMs >= certificate.issuedAtEpochMs && nowEpochMs < certificate.expiresAtEpochMs;
}

function certificateSerial(epochMs) {
  const d = new Date(epochMs);
  const p = (x, n = 2) => String(x).padStart(n, '0');
  return `検一第${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}号`;
}
