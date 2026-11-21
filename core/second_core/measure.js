// measure.js — その端末の時計を実測する。合計 2 秒以内、1 回の連続した計算は数ミリ秒まで。
//
// 測る物:
//   perfTick   performance.now() の目量（連続する異なる値の差）と、目量の内側の揺らぎの有無
//   eventTick  event.timeStamp の目量（作った Event の時刻から。本物の入力の時刻とは経路が違う。source: 'synthetic-event'）
//   raf        requestAnimationFrame の周期と揺れ
//   inputDelay 入力の時刻から処理が走るまでの遅れ（performance.now() − event.timeStamp）
// 測れなかった物は ok: false と理由を返し、推定値では埋めない。
//
// 一秒の検定の式に入るのは目量だけ。押した時刻と離した時刻は event.timeStamp で取るので、
// 画面の書き換えの周期と処理までの遅れは押していた長さの測定に入らず、不確かさの内訳にも入れない。

const CHUNK_MS = 4;            // 1 回の連続した計算の長さの目安
const EVENT_CHUNK_MS = 2;
const START_ITER = 20000;      // 回す回数の上限の初め。速さが分かったら CHUNK_MS に合わせて直す
const MIN_ITER = 5000;
const MAX_ITER = 400000;

const median = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
};
const quantile = (xs, q) => {
  const a = [...xs].sort((p, q2) => p - q2);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
};
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const clean = (x, digits = 6) => Number(x.toPrecision(digits));

/**
 * 1 回分の連続した観測。値が変わるたびに、直前の値との差と、その間に回した回数を記録する。
 * 塊の最初の変化は、いつから今の値だったかが分からないので滞在の回数は使わない（complete = false）。
 * 差のほうは、塊の中で続けて見た2つの値の差なので、隣り合う目盛りの差として使える。
 */
export function sampleChunk(read, { chunkMs = CHUNK_MS, maxIter = START_ITER } = {}) {
  const steps = [];
  let last = read();
  const first = last;
  let iters = 0, complete = false;
  for (let total = 0; total < maxIter; total++) {
    const v = read();
    iters++;
    if (v !== last) {
      steps.push({ diff: v - last, iters, complete });
      complete = true;
      last = v;
      iters = 0;
      if (v - first >= chunkMs) break;
    }
  }
  return { steps, first, last };
}

export const sampleSteps = (read, options) => sampleChunk(read, options).steps;

/**
 * 目量の推定と、目量の内側の揺らぎ（ジッター）の判定。
 * 揺らぎの無い丸めなら、1 目盛りに留まる時間はいつも同じで、回した回数もほぼ一定になる。
 * 目盛りの切り替わりの点を目盛りごとに乱数でずらす作りだと、留まる時間は 0〜2 目量に散らばり、
 * 回数の散らばり（四分位範囲 / 1.349 / 中央値）は約 0.43 になる。
 * 2026-11-20 の実測（results/browser_measure_20261120.json）: Chromium 145・Edge 158・Chrome 157 で、
 * 目量 0.1 ms のとき 0.416〜0.475、時刻の隔離ありの目量 0.005 ms のとき 0.43〜0.575。どちらもこの作りに合う。
 * Firefox と Safari は測っていない（未確認）。
 * 0.2 を境に分ける。1 目盛りあたりの回数が 20 に満たないと判定できないので null を返す。
 */
export function analyzeTickSteps(steps, betweenChunks = []) {
  const diffs = steps.map((s) => s.diff).filter((d) => d > 0);
  if (diffs.length < 3) {
    // 塊の中で値がほとんど変わらない粗い時計。塊と塊の間の差（間は目量より短いので 1 目盛り分）から出す
    const cross = [...diffs, ...betweenChunks.filter((d) => d > 0)];
    if (cross.length < 3) return { ok: false, reason: 'too-few-steps', samples: cross.length };
    const t = clean(median(cross));
    return { ok: true, tickMs: t, minDiffMs: clean(Math.min(...cross)), samples: cross.length, basis: 'between-chunks', dwellSamples: 0, dwellSpread: null, jitter: null };
  }
  const tick = clean(median(diffs));
  const dwell = steps
    .filter((s) => s.complete && s.diff > 0 && Math.abs(s.diff - tick) <= 0.02 * tick)
    .map((s) => s.iters);
  let jitter = null, dwellSpread = null;
  if (dwell.length >= 20 && median(dwell) >= 20) {
    dwellSpread = (quantile(dwell, 0.75) - quantile(dwell, 0.25)) / 1.349 / median(dwell);
    jitter = dwellSpread > 0.2;
  }
  return {
    ok: true,
    tickMs: tick,
    minDiffMs: clean(Math.min(...diffs)),
    samples: diffs.length,
    basis: 'within-chunk',
    dwellSamples: dwell.length,
    dwellSpread: dwellSpread === null ? null : clean(dwellSpread, 3),
    jitter,
  };
}

/** requestAnimationFrame の時刻の列から周期と揺れを出す。 */
export function analyzeRaf(stamps, reason) {
  const intervals = [];
  for (let i = 1; i < stamps.length; i++) intervals.push(stamps[i] - stamps[i - 1]);
  const positive = intervals.filter((d) => d > 0);
  if (positive.length < 10) return { ok: false, reason: reason ?? 'too-few-frames', frames: stamps.length };
  const period = median(positive);
  const steady = positive.filter((d) => d > 0.5 * period && d < 1.5 * period);
  const sd = stdev(steady);
  return {
    ok: true,
    periodMs: clean(period),
    hz: clean(1000 / period, 4),
    jitterSdMs: sd === null ? null : clean(sd, 3),
    minMs: clean(Math.min(...positive)),
    maxMs: clean(Math.max(...positive)),
    longFrames: positive.filter((d) => d >= 1.5 * period).length,
    frames: stamps.length,
  };
}

/**
 * 指やマウスの位置の報告の時刻（getCoalescedEvents の時刻を含む）から、報告の周期を出す。
 * 機器の照会の周期の実測に使う。50 ms を超える間は止まっていた時間として除く。
 */
export function estimateReportInterval(stamps, { minSamples = 16, gapMs = 50 } = {}) {
  const sorted = [...new Set(stamps.filter(Number.isFinite))].sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0 && d < gapMs) diffs.push(d);
  }
  if (diffs.length < minSamples) return { ok: false, reason: 'too-few-reports', samples: diffs.length };
  return { ok: true, periodMs: clean(median(diffs), 4), samples: diffs.length, spreadMs: clean(stdev(diffs) ?? 0, 3) };
}

/** 1 目盛りに留まった回数から、塊が chunkMs 程度になる回す回数を出す。分からなければ今のまま。 */
export function nextMaxIter(steps, chunkMs, current) {
  const rates = steps.filter((s) => s.complete && s.diff > 0).map((s) => s.iters / s.diff);
  if (rates.length < 2) return current;
  return Math.round(Math.min(MAX_ITER, Math.max(MIN_ITER, median(rates) * chunkMs)));
}

/** 入力の時刻が performance.now() と同じ物差しに乗っているか。 */
export function isUsableStamp(ts, nowMs) {
  return Number.isFinite(ts) && ts > 0 && ts <= nowMs + 1 && nowMs - ts < 10000;
}

function browserEnv() {
  const g = globalThis;
  const perf = g.performance;
  return {
    now: () => perf.now(),
    timeOrigin: perf?.timeOrigin ?? null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    raf: typeof g.requestAnimationFrame === 'function' ? (cb) => g.requestAnimationFrame(cb) : null,
    makeEvent: typeof g.Event === 'function' ? () => new g.Event('second-core-probe') : null,
    win: typeof g.addEventListener === 'function' ? g : null,
    visibility: () => g.document?.visibilityState ?? 'visible',
    PerformanceObserver: g.PerformanceObserver ?? null,
    crossOriginIsolated: g.crossOriginIsolated === true,
    userAgent: g.navigator?.userAgent ?? null,
  };
}

/**
 * その端末の時計を測る。返す値はどれも測った物で、測れなかった物は ok: false。
 * options.env で時計や予定の関数を差し替えられる（試験用）。
 */
export async function measureClock(options = {}) {
  const env = { ...browserEnv(), ...(options.env ?? {}) };
  const budgetMs = Math.min(options.budgetMs ?? 1800, 2000);
  const t0 = env.now();
  const deadline = t0 + budgetMs - 60;

  // 入力の遅れ: 期間中に来た本物の入力と、Event Timing の最初の入力
  const delays = [];
  let firstInput = null;
  const onInput = (e) => {
    const n = env.now();
    if (isUsableStamp(e.timeStamp, n)) delays.push(n - e.timeStamp);
  };
  const inputTypes = ['pointerdown', 'keydown'];
  for (const t of inputTypes) env.win?.addEventListener(t, onInput, { capture: true, passive: true });
  let observer = null;
  try {
    if (env.PerformanceObserver?.supportedEntryTypes?.includes('first-input')) {
      observer = new env.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          firstInput = { delayMs: entry.processingStart - entry.startTime, name: entry.name };
        }
      });
      observer.observe({ type: 'first-input', buffered: true });
    }
  } catch { observer = null; }

  // 画面の書き換え: 1 秒か 90 コマまで
  const rafPromise = new Promise((resolve) => {
    if (!env.raf) return resolve({ ok: false, reason: 'no-raf' });
    if (env.visibility() === 'hidden') return resolve({ ok: false, reason: 'hidden' });
    const stamps = [];
    let done = false;
    const until = Math.min(t0 + 1000, deadline);
    const finish = (reason) => {
      if (done) return;
      done = true;
      resolve(analyzeRaf(stamps, reason));
    };
    const step = (ts) => {
      if (done) return;
      stamps.push(ts);
      if (stamps.length >= 90 || env.now() >= until) return finish();
      env.raf(step);
    };
    env.raf(step);
    env.setTimeout(() => finish(stamps.length ? 'timeout' : 'raf-not-firing'), Math.max(0, until - env.now()) + 80);
  });

  // 目量: 数ミリ秒の塊を、間を空けながら繰り返す。細かい時計は早く終わり、粗い時計は期間いっぱい見る。
  // 1 回に回す回数は、1 目盛りに留まった回数から読みの速さを出して、塊が CHUNK_MS 程度になるように直す。
  // 粗い時計では速さが分からないので初めの回数のまま（その端末の速さで 1〜数ミリ秒）。
  const perfSteps = [], eventSteps = [];
  const read = () => env.now();
  const readEvent = env.makeEvent ? () => env.makeEvent().timeStamp : null;
  const lanes = [
    { steps: perfSteps, between: [], read, chunkMs: CHUNK_MS, need: 400, maxIter: START_ITER, prevLast: null },
    ...(readEvent ? [{ steps: eventSteps, between: [], read: readEvent, chunkMs: EVENT_CHUNK_MS, need: 150, maxIter: START_ITER, prevLast: null }] : []),
  ];
  // 粗い時計では、締め切りを過ぎたことに気づくのが最大 1 目盛り遅れ、始めの時刻も最大 1 目盛り早く読める。
  // 見えた差の最大の 2 倍だけ締め切りを前に寄せて、本当の時間でも 2 秒を超えないようにする。
  let widest = 0;
  const stopAt = () => deadline - 2 * widest;
  measuring: while (env.now() < stopAt()) {
    for (const lane of lanes) {
      if (lane.steps.length >= lane.need) continue;
      const got = sampleChunk(lane.read, { chunkMs: lane.chunkMs, maxIter: lane.maxIter });
      if (lane.prevLast !== null) {
        const d = got.first - lane.prevLast;
        lane.between.push(d);
        // 塊の中で値がほとんど変わらない時計では、塊の間の差が目量の手がかりになる
        if (lane.steps.length < 3 && d > widest && d < 500) widest = d;
      }
      lane.prevLast = got.last;
      lane.steps.push(...got.steps);
      lane.maxIter = nextMaxIter(got.steps, lane.chunkMs, lane.maxIter);
      for (const st of got.steps) if (st.diff > widest && st.diff < 500) widest = st.diff;
      if (env.now() >= stopAt()) break measuring;
      await env.sleep(4);
    }
    if (lanes.every((l) => l.steps.length >= l.need)) break;
  }
  const perfTick = analyzeTickSteps(perfSteps, lanes[0].between);
  const eventTick = readEvent ? analyzeTickSteps(eventSteps, lanes[1].between) : { ok: false, reason: 'no-event-constructor' };
  if (eventTick.ok) eventTick.source = 'synthetic-event';

  const raf = await rafPromise;
  for (const t of inputTypes) env.win?.removeEventListener(t, onInput, { capture: true });
  try { observer?.disconnect(); } catch { /* 何もしない */ }

  const inputDelay = delays.length || firstInput
    ? {
        ok: true,
        samples: delays.length,
        medianMs: delays.length ? clean(median(delays), 4) : null,
        maxMs: delays.length ? clean(Math.max(...delays), 4) : null,
        firstInputDelayMs: firstInput ? clean(firstInput.delayMs, 4) : null,
      }
    : { ok: false, reason: 'no-input' };

  const t1 = env.now();
  return {
    version: 1,
    startedAtEpochMs: env.timeOrigin === null ? null : env.timeOrigin + t0,
    elapsedMs: clean(t1 - t0, 5),
    crossOriginIsolated: env.crossOriginIsolated,
    perfTick,
    eventTick,
    raf,
    inputDelay,
    userAgent: env.userAgent,
  };
}
