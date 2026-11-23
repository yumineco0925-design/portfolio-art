// 閲覧数の上位を9日分と、カテゴリでの外し。fetch に見出しは付けない（付けると前もっての確かめで止まる）。
const TOP = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/ja.wikipedia/all-access/';
const API = 'https://ja.wikipedia.org/w/api.php?';
export const DAY = 864e5;
export const MIN = Date.UTC(2015, 6, 1);

// 名前空間つきの題（特別: Wikipedia: ファイル: など）
const NS = /^(特別|Special|Wikipedia|WP|Help|ヘルプ|ファイル|File|画像|Image|Template|Category|Portal|ポータル|プロジェクト|Project|ノート|Talk|利用者|User|MediaWiki|Module|モジュール|Draft|メディア|Media|TimedText|Gadget)([‐\-_ ]?(ノート|会話|talk))?:/i;
export const ADULT = /AV女優|アダルト|ポルノ|性風俗|成人向け|性行為|性的|官能|わいせつ|性犯罪|性加害|ヌード|セックストイ|性具|性玩具|肛門性愛|蔑称|差別用語/;
export const VIOLENT = /殺人事件|殺害事件|自殺事件|バラバラ殺人|大量殺人|殺人犯|殺人被害者|ハイジャック事件|(昭和|平成|令和)時代の事件|日本のテロ/;

export const utc0 = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
export const ymd = (t, sep) => {
  const d = new Date(t);
  return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join(sep);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 入れ物（sessionStorage）。使えなくても動く ---------- */

const KEY = 'yonda:';
function sget(k) {
  try { return sessionStorage.getItem(KEY + k); } catch (e) { return null; }
}
function sclear() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(KEY)) sessionStorage.removeItem(k);
    }
  } catch (e) { /* 使えない */ }
}
function sset(k, v) {
  try { sessionStorage.setItem(KEY + k, v); return; } catch (e) { /* 容量か、使えない */ }
  // 容量の例外なら入れ物を空にして、もう一度だけ入れる
  sclear();
  try { sessionStorage.setItem(KEY + k, v); } catch (e) { /* あきらめて続ける */ }
}
export function storageSize() {
  try {
    let n = 0;
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); n += k.length + (sessionStorage.getItem(k) || '').length; }
    return n;
  } catch (e) { return null; }
}

/* ---------- 取得 ---------- */

export const net = { calls: 0, n429: 0 };

// 混んでいると言われたら 1500ms、3000ms と待って聞き直す（3回まで）
async function getJSON(url, tries = 3) {
  for (let k = 0; k < tries; k++) {
    let w = 400;
    try {
      net.calls++;
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 404) return { __404: true };
      if (r.status === 429) { net.n429++; w = 1500 * 2 ** k; }
    } catch (e) { /* 次へ */ }
    if (k + 1 < tries) await sleep(w);
  }
  return null;
}

// 上位の一覧。404 は null、取れなければ undefined。日付ごとに入れ物に入れ、同じ日は取り直さない。
async function topOf(t) {
  const key = 'top:' + ymd(t, '-');
  const s = sget(key);
  if (s) {
    try {
      const v = JSON.parse(s);
      if (v === 404) return null;
      return v.map(([article, views]) => ({ article, views }));
    } catch (e) { /* 取り直す */ }
  }
  const j = await getJSON(TOP + ymd(t, '/'));
  if (!j) return undefined;
  if (j.__404) {
    // きのうとおとといの 404 は、あとで出るので覚えない
    if (t < utc0(Date.now()) - 2 * DAY) sset(key, '404');
    return null;
  }
  const a = j.items[0].articles;
  sset(key, JSON.stringify(a.map((x) => [x.article, x.views])));
  return a;
}

const stateOf = (a) => (a === undefined ? 'fail' : a === null ? 'none' : 'ok');

// 9日分（紙に刷る8日と、その前の1日）。end が無ければ、最新の日をきのうから前へ下げて探す。
// state は日ごとに ok（数あり）・none（404）・pre（2015年7月1日より前）・fail（取れない）。
export async function loadDays(end) {
  let last = end;
  let lastList;
  if (end === undefined) {
    let t = utc0(Date.now()) - DAY;
    for (let k = 0; k < 4; k++) {
      const a = await topOf(t);
      if (a === undefined) throw new Error('top');
      if (a) { last = t; lastList = a; break; }
      t -= DAY;
    }
    if (lastList === undefined) throw new Error('top');
  }
  const days = Array.from({ length: 9 }, (_, i) => last - (8 - i) * DAY);
  const got = await Promise.all(days.map((d, i) => (d < MIN ? 'pre' : i === 8 && lastList ? lastList : topOf(d))));
  if (got[8] === undefined) throw new Error('top');
  const state = got.map((a) => (a === 'pre' ? 'pre' : stateOf(a)));
  const lists = got.map((a) => (Array.isArray(a) ? a : null));
  return { days, lists, state };
}

// その日の候補（名前空間つきとメインページを外した上位260本）と、前の日の閲覧数。
export function candidatesOf(list, before) {
  const prev = before ? new Map(before.map((a) => [a.article, a.views])) : null;
  return list
    .filter((a) => a.article !== 'メインページ' && !NS.test(a.article))
    .slice(0, 260)
    .map((a) => ({ article: a.article, views: a.views, prev: prev ? prev.get(a.article) : undefined, known: !!prev }));
}

/* ---------- カテゴリ ---------- */

// 題 → [名前空間, カテゴリの名前（Category: を外す、隠しカテゴリは除く）]、ページが無ければ 0。
const raw = new Map();
try {
  const s = sget('cats');
  if (s) for (const [k, v] of Object.entries(JSON.parse(s))) raw.set(k, v);
} catch (e) { /* 取り直す */ }
let dirty = false;
let saveTimer = 0;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!dirty) return;
  dirty = false;
  sset('cats', JSON.stringify(Object.fromEntries(raw)));
}
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(saveNow, 400); }
addEventListener('pagehide', saveNow);

async function runBatch(titles, res) {
  for (const t of titles) res.set(t, { cats: [], ns: null, ok: false, bad: false, net: false });
  let cont = {};
  for (let guard = 0; guard < 30; guard++) {
    const p = new URLSearchParams({
      action: 'query', prop: 'categories', clshow: '!hidden', cllimit: 'max',
      titles: titles.join('|'), redirects: '1', format: 'json', formatversion: '2', origin: '*', ...cont,
    });
    const q = await getJSON(API + p, 3);
    if (!q || !q.query) { for (const t of titles) { const r = res.get(t); r.bad = true; r.net = true; } return; }
    const norm = new Map((q.query.normalized || []).map((n) => [n.from, n.to]));
    const red = new Map((q.query.redirects || []).map((n) => [n.from, n.to]));
    const back = new Map();
    for (const t of titles) {
      let f = norm.get(t) ?? t;
      f = red.get(f) ?? f;
      if (!back.has(f)) back.set(f, []);
      back.get(f).push(t);
    }
    for (const pg of q.query.pages || []) {
      for (const o of back.get(pg.title) || []) {
        const r = res.get(o);
        if (pg.missing || pg.invalid) { r.bad = true; continue; }
        r.ok = true;
        r.ns = pg.ns;
        for (const c of pg.categories || []) r.cats.push(c.title.replace(/^Category:/, ''));
      }
    }
    if (q.continue) cont = q.continue; else break;
  }
}

function judge(article, v) {
  if (v === undefined) return { keep: false, kind: 'nocat', where: '取れない', net: true, cats: [] };
  if (!v) return { keep: false, kind: 'nocat', where: '取れない', cats: [] };
  const [ns, cats] = v;
  if (ns !== 0) return { keep: false, kind: 'ns', where: 'ns' + ns, cats };
  if (!cats.length) return { keep: false, kind: 'nocat', where: 'カテゴリ0', cats };
  const disp = article.replace(/_/g, ' ');
  for (const [kind, re] of [['adult', ADULT], ['violent', VIOLENT]]) {
    if (re.test(disp)) return { keep: false, kind, where: '題', cats };
    const cat = cats.find((x) => re.test(x));
    if (cat) return { keep: false, kind, where: cat, cats };
  }
  // 残した記事のカテゴリは、組を作るのに使うので捨てずに持つ
  return { keep: true, cats };
}

// 一度確かめた記事は覚えておき、ほかの日では確かめ直さない（通信で取れなかった物は入れ物に入れない）。
const verdicts = new Map();

// 題のカテゴリを、同時に3本までで size 本ずつ取る（URL が長くなりすぎない所で切る）。
// 外す語に当たる物と、カテゴリが取れない物は外す。1束終わるごとに onBatch を呼ぶ。
export async function checkTitles(titles, opt = {}) {
  const size = opt.size || 20;
  const uniq = [...new Set(titles.filter((a) => !verdicts.has(a)))];
  const todo = [];
  for (const a of uniq) {
    if (raw.has(a)) verdicts.set(a, judge(a, raw.get(a)));
    else todo.push(a);
  }
  const batches = [];
  let cur = [];
  let len = 0;
  for (const a of todo) {
    const l = encodeURIComponent(a).length + 3;
    if (cur.length && (cur.length >= size || len + l > 5000)) { batches.push(cur); cur = []; len = 0; }
    cur.push(a);
    len += l;
  }
  if (cur.length) batches.push(cur);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const res = new Map();
      await runBatch(b, res);
      for (const a of b) {
        const r = res.get(a);
        if (r.ok) raw.set(a, [r.ns, r.cats]);
        else if (r.bad && !r.net) raw.set(a, 0);
        // 通信で取れなかった物も、開いている間は外したままにする（確かめていない題は刷らない）
        verdicts.set(a, judge(a, raw.get(a)));
      }
      dirty = true;
      saveSoon();
      if (opt.onBatch) opt.onBatch();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  saveNow();
  return { asked: todo.length, stored: uniq.length - todo.length, batches: batches.length };
}

export function verdictOf(article) { return verdicts.get(article) || { keep: false, kind: 'nocat', where: '取れない', cats: [] }; }
export function hasVerdict(article) { return verdicts.has(article); }
