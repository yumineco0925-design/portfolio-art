// index.js — 一秒の検定所の計算の芯。部品をまとめ、ボタン1つから票までをつなぐ。見た目は持たない。

export * as stats from './stats.js';
export * as measure from './measure.js';
export * as hold from './hold.js';
export * as gum from './gum.js';
export * as decide from './decide.js';
export * as balance from './balance.js';
export * as feed from './feed.js';
export * as record from './console.js';

import { measureClock } from './measure.js';
import { attachHold } from './hold.js';
import { evaluate } from './gum.js';
import { decide as decideFn, CERTIFICATE_VALIDITY_MS } from './decide.js';
import { createFeed } from './feed.js';
import { printBoot, printTicket, installInspector } from './console.js';

/**
 * 検定所を開く。
 * options:
 *   button      本物の button 要素（必須）
 *   mode        'hold' | 'twice'
 *   maxSeries   繰り返しに数える回数の上限（新しい方から）。既定 10
 *   onTicket({ hold, result, decision, n }), onVoid(voidResult), onState(state), onExpire(certificate)
 *   feed        createFeed の options。false なら取りに行かず既定の公差
 *   logger      console と同じ形。null なら何も出さない
 *   inspector   true なら globalThis.検定所 を置く
 */
export function createStation(options = {}) {
  const {
    button,
    maxSeries = 10,
    onTicket, onVoid, onState, onExpire,
    logger = globalThis.console,
    inspector = true,
    clockOptions = {},
    holdOptions = {},
  } = options;
  if (!button) throw new TypeError('button が要る');

  const feed = options.feed === false ? null : createFeed(options.feed ?? {});
  let clock = null;
  let last = null;
  let series = [];
  let seriesMode = null;
  let expiryTimer = null;

  const clockPromise = measureClock(clockOptions).then((c) => { clock = c; return c; });
  const feedPromise = feed ? feed.refresh().catch(() => feed.current()) : Promise.resolve(null);
  const ready = Promise.all([clockPromise, feedPromise]).then(([c, f]) => {
    if (logger) printBoot({ clock: c, feed: f }, logger);
    return { clock: c, feed: f };
  });

  const tolerance = () => feed?.current().tolerance ?? { nominalMs: 1000, halfWidthMs: 50, grade: '三級' };

  async function handleRelease(h) {
    const { clock: c } = await ready;
    if (seriesMode !== h.mode) { series = []; seriesMode = h.mode; }
    series.push(h);
    if (series.length > maxSeries) series = series.slice(-maxSeries);
    const result = evaluate({ holds: series, clock: c });
    const decision = decideFn(result, tolerance());
    last = { hold: h, result, decision, n: series.length };
    if (logger) printTicket(result, decision, logger);
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (decision.certificate) {
      const cert = decision.certificate;
      expiryTimer = setTimeout(() => { expiryTimer = null; onExpire?.(cert); }, CERTIFICATE_VALIDITY_MS);
    }
    onTicket?.(last);
    return last;
  }

  const handle = attachHold(button, {
    ...holdOptions,
    mode: options.mode,
    onRelease: (h) => { handleRelease(h).catch((e) => logger?.error?.(e)); },
    onVoid: (v) => onVoid?.(v),
    onState: (s) => onState?.(s),
  });

  if (inspector) {
    installInspector({ clock: () => clock, feed: () => feed?.current() ?? null, last: () => last, series: () => series.map((h) => h.durationMs) });
  }

  return {
    ready,
    setMode(m) { handle.setMode(m); series = []; seriesMode = null; },
    resetSeries() { series = []; seriesMode = null; },
    last: () => last,
    clock: () => clock,
    detach() { handle.detach(); if (expiryTimer !== null) clearTimeout(expiryTimer); },
  };
}
