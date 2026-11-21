// feed.js — その日の公差。米国地質調査所（USGS）の直近 1 時間の地震の一覧の、いちばん新しい地震の規模で決める。
//
// 地震と一秒の公差には何の関係も無い。対応は M の表記（小数 1 桁）の FNV-1a 32 ビットのハッシュを 6 で割った余りで、
// わざと不規則にしてある。同じ M はいつも同じ級になる。関係の説明は画面に出さない。
//
// 受信できなかったときは、前に受け取った値を使い、状態を「受信なし」にする。前の値も無ければ既定の三級。
// 前の値は localStorage に置く。使えない端末（非公開の窓など）では置かずに進む。
// 地名は外から来る文字列なので、制御文字を除き 80 字で切る。画面に出すときは textContent で入れること。

import { roundToDecimals } from './gum.js';

export const USGS_ALL_HOUR = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
export const STORAGE_KEY = 'second-core:feed:v1';

/** 級と公差の半幅。並びの番号がハッシュの余りに当たる。 */
export const GRADES = Object.freeze([
  Object.freeze({ grade: '特級', halfWidthMs: 5 }),
  Object.freeze({ grade: '一級', halfWidthMs: 10 }),
  Object.freeze({ grade: '二級', halfWidthMs: 25 }),
  Object.freeze({ grade: '三級', halfWidthMs: 50 }),
  Object.freeze({ grade: '四級', halfWidthMs: 100 }),
  Object.freeze({ grade: '五級', halfWidthMs: 200 }),
]);
export const DEFAULT_GRADE_INDEX = 3;

export const STATUS_TEXT = Object.freeze({
  live: '受信',
  quiet: '受信（直近 1 時間の記録なし）',
  stale: '受信なし',
  default: '受信なし',
});

/** FNV-1a 32 ビット。入力は ASCII の文字列（M の表記）だけを想定する。 */
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** M の表記。小数 1 桁に四捨五入（0.5 は 0 から遠い側。gum.roundToDecimals と同じ）。 */
export function magnitudeText(mag) {
  return roundToDecimals(mag, 1).text;
}

/** 地震の規模から級を引く。 */
export function gradeForMagnitude(mag) {
  if (!Number.isFinite(mag)) return { ...GRADES[DEFAULT_GRADE_INDEX], index: DEFAULT_GRADE_INDEX, key: null, hash: null };
  const key = `M${magnitudeText(mag)}`;
  const hash = fnv1a32(key);
  const index = hash % GRADES.length;
  return { ...GRADES[index], index, key, hash };
}

function sanitizePlace(place) {
  if (typeof place !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return place.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 80);
}

/**
 * GeoJSON からいちばん新しい地震。種類が earthquake で、規模と時刻が数の物だけを見る。
 * 採石の発破などは除く。見つからなければ null。
 */
export function latestQuake(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  let best = null;
  for (const f of features) {
    const p = f?.properties;
    if (!p || (p.type ?? 'earthquake') !== 'earthquake') continue;
    if (!Number.isFinite(p.mag) || !Number.isFinite(p.time)) continue;
    if (!best || p.time > best.timeEpochMs) {
      best = { id: typeof f.id === 'string' ? f.id.slice(0, 40) : null, mag: p.mag, place: sanitizePlace(p.place), timeEpochMs: p.time };
    }
  }
  return best;
}

/** 出来事の行。例「21:03 10 km SW of Anza, CA M4.6」。時刻は見ている人の時間帯（timeZone で差し替え）。 */
export function formatEventLine(quake, { timeZone } = {}) {
  if (!quake) return '';
  const fmt = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(quake.timeEpochMs)).map((x) => [x.type, x.value]));
  const hhmm = `${parts.hour}:${parts.minute}`;
  return [hhmm, quake.place, `M${magnitudeText(quake.mag)}`].filter(Boolean).join(' ');
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readStored(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const q = v?.quake;
    if (!q || !Number.isFinite(q.mag) || !Number.isFinite(q.timeEpochMs) || !Number.isFinite(v.receivedAtEpochMs)) return null;
    return { quake: { id: typeof q.id === 'string' ? q.id.slice(0, 40) : null, mag: q.mag, place: sanitizePlace(q.place), timeEpochMs: q.timeEpochMs }, receivedAtEpochMs: v.receivedAtEpochMs };
  } catch {
    return null;
  }
}

function writeStored(storage, value) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(value)); return true; } catch { return false; }
}

/**
 * 公差の受け取り。
 * options: fetchImpl, storage, url, timeoutMs, minIntervalMs, now（epoch ms）, timeZone
 * refresh() で取りに行き、current() で今の公差を返す。
 */
export function createFeed(options = {}) {
  const {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    url = USGS_ALL_HOUR,
    timeoutMs = 5000,
    minIntervalMs = 60000,   // 元の一覧は 1 分ごとに作り直される。それより速く取りに行かない
    now = () => Date.now(),
    timeZone,
  } = options;
  const storage = 'storage' in options ? options.storage : defaultStorage();

  let state = build(readStored(storage) ? 'stale' : 'default', readStored(storage));
  let lastFetchAt = -Infinity;
  let inflight = null;

  function build(status, stored, extra = {}) {
    const quake = stored?.quake ?? null;
    const g = quake ? gradeForMagnitude(quake.mag) : { ...GRADES[DEFAULT_GRADE_INDEX], index: DEFAULT_GRADE_INDEX, key: null, hash: null };
    return {
      status,
      statusText: STATUS_TEXT[status],
      reception: status === 'live' || status === 'quiet' ? 'ok' : 'none',
      tolerance: { nominalMs: 1000, halfWidthMs: g.halfWidthMs, grade: g.grade },
      gradeIndex: g.index,
      hashKey: g.key,
      hash: g.hash,
      quake,
      eventLine: formatEventLine(quake, { timeZone }),
      receivedAtEpochMs: stored?.receivedAtEpochMs ?? null,
      ...extra,
    };
  }

  async function fetchOnce() {
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'no-fetch' };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl?.signal, cache: 'no-store', credentials: 'omit', mode: 'cors' });
      if (!res?.ok) return { ok: false, error: `http-${res?.status ?? '?'}` };
      return { ok: true, json: await res.json() };
    } catch (e) {
      return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh({ force = false } = {}) {
    if (!force && now() - lastFetchAt < minIntervalMs) return state;
    if (inflight) return inflight;
    inflight = (async () => {
      lastFetchAt = now();
      const r = await fetchOnce();
      const stored = readStored(storage);
      if (!r.ok) {
        state = build(stored ? 'stale' : 'default', stored, { error: r.error });
        return state;
      }
      const q = latestQuake(r.json);
      if (!q) {
        state = build('quiet', stored);
        return state;
      }
      const value = { quake: q, receivedAtEpochMs: now() };
      const saved = writeStored(storage, value);
      state = build('live', value, { saved });
      return state;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  return { refresh, current: () => state };
}
