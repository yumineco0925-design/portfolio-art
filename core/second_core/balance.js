// balance.js — 天秤の竿の傾き。減衰のある振動を閉じた形の解で解く（数値積分はしない）。
//
//   θ'' + 2ζω₀ θ' + ω₀² (θ − θ*) = 0
//   θ* は目標の傾き。持ち込まれた一秒が 1.000 s より長いほど、持ち込まれた側の皿が下がる（θ > 0）。
//   x = θ − θ*、x(0) = x0、x'(0) = v0 として
//   ζ < 1  x = e^{−ζω₀t} (x0 cos ω_d t + (v0 + ζω₀x0)/ω_d · sin ω_d t)、ω_d = ω₀√(1 − ζ²)
//   ζ = 1  x = (x0 + (v0 + ω₀x0) t) e^{−ω₀t}
//   ζ > 1  x = C1 e^{r1 t} + C2 e^{r2 t}、r1,2 = −ω₀(ζ ∓ √(ζ² − 1))
// 目標が途中で変わったら、その時刻の角度と角速度を新しい初期値にして解き直す。
// 傾きは、事前に焼いた連番（−θmax〜+θmax を N コマ、等間隔）のコマ番号に写す。

export const DEFAULTS = Object.freeze({
  periodS: 1.6,        // 減衰の無いときの周期
  zeta: 0.35,          // 減衰比。行き過ぎは約 31 %、揺れは 5 秒以内に半コマより小さくなる（WCAG 2.2.2 の 5 秒）
  thetaMaxRad: (12 * Math.PI) / 180,  // 焼いた連番の端の傾き
  targetFraction: 0.6, // 目標の傾きの上限を端の 6 割にする。端から端へ振れても行き過ぎが端を越えない
  saturationMs: 120,   // 差がこの程度で傾きが飽き始める
  frames: 49,          // 奇数にして、水平（ちょうど 1.000 s）のコマを1枚持つ
});

/** 一秒との差（ms）から目標の傾き。tanh で滑らかに頭打ちにし、竿受けを超えない。 */
export function targetAngle(diffMs, { thetaMaxRad = DEFAULTS.thetaMaxRad, targetFraction = DEFAULTS.targetFraction, saturationMs = DEFAULTS.saturationMs } = {}) {
  if (!Number.isFinite(diffMs)) return 0;
  return targetFraction * thetaMaxRad * Math.tanh(diffMs / saturationMs);
}

/** 初期値 (x0, v0) からの自由振動の閉じた形の解。{ x, v } を返す。 */
export function dampedResponse(t, x0, v0, omega0, zeta) {
  if (t < 0) throw new RangeError('t は 0 以上');
  const w = omega0;
  if (zeta < 1) {
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const a = zeta * w;
    const B = (v0 + a * x0) / wd;
    const e = Math.exp(-a * t);
    const c = Math.cos(wd * t), s = Math.sin(wd * t);
    const x = e * (x0 * c + B * s);
    const v = e * ((-a * x0 + B * wd) * c + (-x0 * wd - a * B) * s);
    return { x, v };
  }
  if (zeta === 1) {
    const e = Math.exp(-w * t);
    const A = v0 + w * x0;
    return { x: (x0 + A * t) * e, v: (A - w * (x0 + A * t)) * e };
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w * (zeta - root), r2 = -w * (zeta + root);
  const C1 = (v0 - r2 * x0) / (r1 - r2);
  const C2 = x0 - C1;
  const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
  return { x: C1 * e1 + C2 * e2, v: C1 * r1 * e1 + C2 * r2 * e2 };
}

/** 包絡線が tol を下回るまでの時間（ζ < 1）。それ以外は x と v が両方小さくなる時刻を探す。 */
export function settleTime(x0, v0, omega0, zeta, tol) {
  if (Math.abs(x0) < tol && Math.abs(v0) < tol * omega0) return 0;
  if (zeta < 1) {
    const a = zeta * omega0;
    const wd = omega0 * Math.sqrt(1 - zeta * zeta);
    const amp = Math.hypot(x0, (v0 + a * x0) / wd);
    return Math.max(0, Math.log(amp / tol) / a);
  }
  let t = 0;
  const dt = 0.01;
  while (t < 60) {
    const { x } = dampedResponse(t, x0, v0, omega0, zeta);
    if (Math.abs(x) < tol) {
      let ok = true;
      for (let s = t; s < t + 1; s += dt) if (Math.abs(dampedResponse(s, x0, v0, omega0, zeta).x) >= tol) { ok = false; break; }
      if (ok) return t;
    }
    t += dt;
  }
  return Infinity;
}

/** 傾きから連番のコマ番号。範囲の外は端のコマにして clamped を立てる。 */
export function angleToFrame(theta, { frames = DEFAULTS.frames, thetaMaxRad = DEFAULTS.thetaMaxRad } = {}) {
  const pos = ((theta + thetaMaxRad) / (2 * thetaMaxRad)) * (frames - 1);
  const clamped = pos < 0 || pos > frames - 1;
  const index = Math.min(frames - 1, Math.max(0, Math.round(pos)));
  return { index, clamped, residualRad: theta - frameToAngle(index, { frames, thetaMaxRad }) };
}

/** コマ番号から、そのコマを焼いた傾き。 */
export function frameToAngle(index, { frames = DEFAULTS.frames, thetaMaxRad = DEFAULTS.thetaMaxRad } = {}) {
  return -thetaMaxRad + (2 * thetaMaxRad * index) / (frames - 1);
}

/**
 * 天秤。時刻は秒（performance.now()/1000 など、単調に進む物）。
 * set(diffMs, t) で目標を変え、at(t) で { theta, omega, frame } を返す。
 */
export function createBalance(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const omega0 = (2 * Math.PI) / cfg.periodS;
  let t0 = 0, x0 = 0, v0 = 0, target = 0;

  const stateAt = (t) => {
    const { x, v } = dampedResponse(Math.max(0, t - t0), x0, v0, omega0, cfg.zeta);
    return { theta: target + x, omega: v };
  };

  return {
    config: cfg,
    omega0,
    set(diffMs, t) {
      const now = stateAt(t);
      target = targetAngle(diffMs, cfg);
      t0 = t;
      x0 = now.theta - target;
      v0 = now.omega;
      return { target, settleS: settleTime(x0, v0, omega0, cfg.zeta, (2 * cfg.thetaMaxRad) / (cfg.frames - 1) / 2) };
    },
    at(t) {
      const s = stateAt(t);
      return { ...s, target, frame: angleToFrame(s.theta, cfg) };
    },
    /** 動きを減らす設定の端末向け: 揺らさずに止まる先のコマ。 */
    restingFrame() {
      return angleToFrame(target, cfg);
    },
  };
}
