// console.js — 開発者の道具の窓に残す、起動の記録と票の内訳。役所の書類の調子で、乾いた文だけを出す。
// 絵文字と感嘆符は使わない（試験で確かめる）。

const pad = (x, n = 2) => String(x).padStart(n, '0');

/** 和暦の日付と時刻（端末の時間帯）。令和の始まり 2019-05-01 より前は西暦で書く。 */
export function officialDate(epochMs) {
  const d = new Date(epochMs);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  const reiwa = y > 2019 || (y === 2019 && m >= 5);
  const era = reiwa ? `令和${y - 2018 === 1 ? '元' : y - 2018}年` : `${y}年`;
  return `${era}${m}月${day}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const tickLine = (t, name) => {
  if (!t?.ok) return `${name}　測れなかった（${t?.reason ?? '理由不明'}）`;
  const jit = t.jitter === true ? `目量の内側の揺らぎ　あり（滞在の散らばり ${t.dwellSpread}）`
    : t.jitter === false ? `目量の内側の揺らぎ　なし（滞在の散らばり ${t.dwellSpread}）`
    : '目量の内側の揺らぎ　判定できず';
  return `${name}　目量 ${t.tickMs} ms。${jit}`;
};

/** 起動の記録の行。 */
export function bootLines({ clock, feed, issuedAtEpochMs = Date.now(), version = '1' } = {}) {
  const lines = [];
  lines.push('一秒の検定所　起動の記録');
  lines.push(`記録の時刻　${officialDate(issuedAtEpochMs)}（この端末の時計による。この時計は校正されていない）`);
  lines.push(`計算の版　${version}　依拠する文書　JCGM 100:2008（GUM）、JCGM 106:2012`);
  if (clock) {
    lines.push(`一　${tickLine(clock.perfTick, '時計（performance.now）')}`);
    lines.push(`二　${tickLine(clock.eventTick, '入力の時刻（event.timeStamp、作った Event による）')}`);
    const r = clock.raf;
    lines.push(`三　画面の書き換え　${r?.ok ? `${r.hz} Hz、揺れ ${r.jitterSdMs ?? '-'} ms` : `測れなかった（${r?.reason ?? '理由不明'}）`}。票の計算には使わない`);
    lines.push(`四　時刻の隔離　${clock.crossOriginIsolated ? 'あり' : 'なし'}`);
    lines.push(`五　測定に要した時間　${clock.elapsedMs} ms（上限 2000 ms）`);
  } else {
    lines.push('一　時計の実測　未実施');
  }
  lines.push('六　端末の時計の周波数の偏り　評価できない（比べる標準器が無い）');
  if (feed) {
    const t = feed.tolerance;
    lines.push(`七　本日の公差　±${t.halfWidthMs} ms（${t.grade}）。${feed.statusText}${feed.eventLine ? `。${feed.eventLine}` : ''}`);
  }
  lines.push('以上');
  return lines;
}

/** 票の内訳の表（console.table 用）。 */
export function budgetTable(result) {
  return result.rows.map((r) => ({
    記号: r.symbol,
    名前: r.name,
    型: r.type,
    分布: r.distribution,
    半幅_ms: r.halfWidthMs === null ? '-' : Number(r.halfWidthMs.toPrecision(4)),
    除数: r.divisorText,
    感度: r.c,
    u_ms: Number(r.uMs.toPrecision(4)),
    寄与_ms: Number(r.uiMs.toPrecision(4)),
    自由度: Number.isFinite(r.nu) ? r.nu : '∞',
    出所: r.source === 'measured' ? '実測' : '仮定',
    条項: r.clause,
  }));
}

/** 票の行。 */
export function ticketLines(result, decision) {
  const lines = [];
  lines.push(`測定量　${result.measurand}`);
  lines.push(`測定の式　${result.model}`);
  lines.push(`結果　${result.display.line}`);
  lines.push(`合成標準不確かさ ${result.display.uc} ms、有効自由度 ${result.display.nuEff}（用いた値 ${result.display.nuUsed}）`);
  for (const x of result.notEvaluated) lines.push(`評価できない物　${x.name}（${x.reason}）`);
  if (decision) {
    lines.push(`公差　${decision.tolerance.text}${decision.tolerance.grade ? `（${decision.tolerance.grade}）` : ''}`);
    lines.push(`判定　${decision.label}。適合の確率 ${decision.display.pc}、測定の能力の指数 ${decision.display.Cm}`);
    if (decision.acceptance.empty) lines.push('受け入れの区間　空（この端末の不確かさでは、この公差に合格は出ない）');
    if (decision.certificate) lines.push(`合格証　${decision.certificate.serial}。有効期間 ${decision.certificate.validityMs} ms`);
  }
  return lines;
}

/** 起動の記録を出す。logger は console と同じ形の物。 */
export function printBoot(args, logger = globalThis.console) {
  const lines = bootLines(args);
  logger?.log?.(lines.join('\n'));
  return lines;
}

/** 票を出す。 */
export function printTicket(result, decision, logger = globalThis.console) {
  const lines = ticketLines(result, decision);
  logger?.log?.(lines.join('\n'));
  logger?.table?.(budgetTable(result));
  return lines;
}

/**
 * 開発者の道具の窓から読める窓口（globalThis.検定所）。値を返すだけで、計算は書き換えない。
 * get: { clock(), feed(), last(), series() }
 */
export function installInspector(get, target = globalThis) {
  const api = Object.freeze({
    版: '1',
    依拠: Object.freeze(['JCGM 100:2008', 'JCGM 106:2012']),
    時計: () => get.clock?.() ?? null,
    公差: () => get.feed?.() ?? null,
    票: () => get.last?.() ?? null,
    内訳() {
      const last = get.last?.();
      if (!last?.result) return '票はまだ無い';
      globalThis.console?.table?.(budgetTable(last.result));
      return last.result.statement;
    },
    繰り返し: () => get.series?.() ?? [],
  });
  try {
    Object.defineProperty(target, '検定所', { value: api, configurable: true, enumerable: false, writable: false });
  } catch { /* 何もしない */ }
  return api;
}
