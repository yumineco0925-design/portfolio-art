// きのう、日本が読んだもの。
// 日本語版 Wikipedia のその日の上位200を、1本のレシートに刷る。下へ送ると前の日のレシートが続く。
// ?d=2025-03-19 でその日を刷る。8日のカテゴリがそろうと、その日にまとめて増えた記事のカテゴリを札で出す。
import { loadDays, candidatesOf, checkTitles, verdictOf, hasVerdict, DAY, MIN, utc0, ymd, net, storageSize } from './data.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const side = matchMedia('(min-width: 900px)');
const dur = (v) => (reduce.matches ? 0 : v);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

const WD = '日月火水木金土';
const U = (t) => new Date(t);
const md = (t) => `${U(t).getUTCMonth() + 1}月${U(t).getUTCDate()}日`;
const wd = (t) => WD[U(t).getUTCDay()];
const fullDate = (t) => `${U(t).getUTCFullYear()}年${md(t)}（${wd(t)}）`;
const slash = (t) => `${U(t).getUTCMonth() + 1}/${U(t).getUTCDate()}`;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/_/g, ' ');
const wikiURL = (a) => 'https://ja.wikipedia.org/wiki/' + encodeURIComponent(a).replace(/%2F/g, '/').replace(/%3A/g, ':');

const sheet = $('#sheet');
const track = $('#track');
const q = $('#q');
const numEl = $('#total-num');
const totalEl = $('#total');
const meter = $('#meter');
const ruler = $('#ruler');
const mark = $('#mark');
const nowEl = $('#now');
const mouth = $('.mouth');
const G = $('#groups');
let body = $('#body');

const LATEST = 8;
const TODAY = utc0(Date.now());
const YEST = TODAY - DAY;
const SUB = '日本語版 Wikipedia　読まれた記事 上位200';
const NOTE_DAY = 'この日の上位200が読まれた回数';
const MSG = {
  bad: 'その日付はありません',
  pre: '数があるのは2015年7月1日からです',
  future: 'まだ来ていない日です',
  notyet: 'この日の数はまだ出ていません',
  none: 'この日の数は Wikimedia にありません',
};
const G_NOTE = 'まとめ＝前の日の2倍以上に増えた記事（新を含む）が3本以上入っている、Wikipedia のカテゴリ。名前はカテゴリの名前です。';
const G_NOTE1 = 'まとめ＝前の日の2倍以上に増えた記事（新を含む）が3本以上入っている、Wikipedia のカテゴリ。';

const S = {
  days: [], lists: [], views: [], state: [],
  D: new Map(),          // 日の番号 → その日の200行（確かめ終わった日だけ）
  printed: [],           // 刷った日（新しい順）
  mode: 'views',
  query: '',
  group: 0,              // 押している札（1〜3、0 は押していない）
  groups: [],
  markOf: null,          // 題 → 組の番号（刷る日の行だけ）
  ready: false,
  open: null,
  curDay: LATEST,
  search: null,
  t: null,               // 刷る日
  hasD: false,           // URL に ?d= がある
};
const stats = {
  topMs: null, catLatestMs: null, rowsAt: null, printedAt: null, restDoneAt: null, groupsAt: null, earlyHead: false,
  uniqueTitles: 0, perDay: {}, excluded: {}, groups: [],
};
window.__yonda = { S, stats, net, storageSize };

/* ---------- 1日の200行 ---------- */

function buildDay(i) {
  const cands = candidatesOf(S.lists[i], S.lists[i - 1]);
  const kept = [];
  const ex = [];
  for (const c of cands) {
    if (kept.length >= 200) break;
    const v = verdictOf(c.article);
    if (v.keep) kept.push(c); else ex.push(v);
  }
  const rows = kept.map((c, j) => {
    const name = c.article.replace(/_/g, ' ');
    return {
      a: c.article, name, n: norm(name), v: c.views, p: c.prev, day: i, rank: j + 1,
      isNew: c.known && c.prev === undefined,
      pct: c.prev ? Math.round(((c.views - c.prev) / c.prev) * 100) : null,
    };
  });
  const d = {
    i, t: S.days[i], rows,
    total: rows.reduce((s, r) => s + r.v, 0),
    newCount: S.lists[i - 1] ? rows.filter((r) => r.isNew).length : null,
  };
  S.D.set(i, d);
  // 外した数と理由のカテゴリ（題は残さない）
  const reasons = {};
  for (const v of ex) { const k = `${v.kind}:${v.where}`; reasons[k] = (reasons[k] || 0) + 1; }
  stats.excluded[slash(d.t)] = { n: ex.length, reasons };
  return d;
}

function seriesOf(a) {
  const s = [];
  for (let i = 1; i <= 8; i++) s.push(S.views[i] ? S.views[i].get(a) : undefined);
  return s;
}

function sortRows(rs) {
  if (S.mode === 'new') return rs.filter((r) => r.isNew);
  if (S.mode === 'up' || S.mode === 'down') {
    const sign = S.mode === 'up' ? -1 : 1;
    const has = rs.filter((r) => r.pct !== null).sort((a, b) => sign * (a.pct - b.pct) || b.v - a.v);
    return has.concat(rs.filter((r) => r.pct === null));
  }
  return rs;
}
const rowsFor = (d) => sortRows(d.rows);

/* ---------- 札（その日にまとめて増えた記事のカテゴリ） ---------- */

// 名前で外すカテゴリ（Category: を外した名前に当てる）
const DROP = [
  /^\d+年(生|没)$/, /^(紀元前)?\d+(世紀|年代)/, /存命人物/, /出身の/, /加盟国$/,
  /(所属者|関係者|関連人物|出演者|審査員|受賞者|選出選手)$/, /提供依頼|スタブ|曖昧さ回避/,
  /病|症|障害|死|没|逮捕|犯罪|事故/, /^\d+人組/, /国$/, /メダリスト$/,
];
const catName = (c) => c.replace(/\s*[\(（][^\)）]*[\)）]$/, '');
const cpLen = (s) => [...s].length;

function computeGroups() {
  const d = S.D.get(LATEST);
  if (!d || !S.lists[LATEST - 1]) return [];
  // 対象の行: 新か、前の日の2倍以上
  const tgt = d.rows.filter((r) => r.p === undefined || r.v / r.p - 1 >= 1);
  // 分母の集まり: 紙の8日の候補のうち、外していない記事（重複は除く）
  const den = new Set();
  for (let i = 1; i <= 8; i++) {
    if (!S.lists[i]) continue;
    for (const c of candidatesOf(S.lists[i], S.lists[i - 1])) if (verdictOf(c.article).keep) den.add(c.article);
  }
  const n = new Map();
  for (const a of den) for (const c of new Set(verdictOf(a).cats)) n.set(c, (n.get(c) || 0) + 1);
  const km = new Map();
  for (const r of tgt) for (const c of new Set(verdictOf(r.a).cats)) { if (!km.has(c)) km.set(c, []); km.get(c).push(r); }
  const passed = [];
  for (const [c, mem] of km) {
    if (DROP.some((re) => re.test(c))) continue;
    const k = mem.length, nn = n.get(c) || k, ratio = k / nn;
    if ((k >= 5 && ratio >= 0.5) || (k >= 3 && ratio >= 0.75)) passed.push({ cat: c, name: catName(c), rows: mem, k, n: nn, ratio, sum: mem.reduce((s, r) => s + r.v, 0) });
  }
  passed.sort((a, b) => b.sum - a.sum || b.ratio - a.ratio || cpLen(a.name) - cpLen(b.name));
  const taken = [];
  const used = new Set();
  for (const g of passed) {
    if (taken.length >= 3) break;
    if (g.rows.some((r) => used.has(r.a))) continue;
    if (Math.min(...g.rows.map((r) => r.rank)) > 50) continue;
    g.rows = [...g.rows].sort((a, b) => a.rank - b.rank);
    taken.push(g);
    for (const r of g.rows) used.add(r.a);
  }
  stats.groupPassed = passed.length;
  return taken;
}

const markOf = (r) => (S.markOf && r.day === LATEST ? S.markOf.get(r.a) || 0 : 0);
const mkHTML = (n) => `<b class="mk" aria-hidden="true">${n}</b>`;

function cardsHTML() {
  return S.groups.map((g, j) => `<button class="card" type="button" data-g="${j + 1}" aria-pressed="false"><span class="cd-top"><b class="cd-mk" aria-hidden="true">${j + 1}</b><span class="cd-name">${esc(g.name)}</span></span><span class="cd-line"><span>カテゴリの記事 ${g.k}点</span><strong>${fmt(g.sum)}<small>回</small></strong></span></button>`).join('');
}

function fitCards() {
  for (const el of $$('.cd-name', G)) {
    el.style.fontSize = '';
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (fs > 18 && el.scrollWidth > el.clientWidth + 0.5) { fs -= 1; el.style.fontSize = `${fs}px`; }
  }
}

function setCards() {
  for (const b of $$('.card', G)) b.setAttribute('aria-pressed', +b.dataset.g === S.group ? 'true' : 'false');
}

async function showGroups() {
  const gs = computeGroups();
  stats.groups = gs.map((g) => ({ name: g.name, cat: g.cat, k: g.k, n: g.n, sum: g.sum, rows: g.rows.map((r) => [r.rank, r.name, r.v]) }));
  root.dataset.groups = String(gs.length);
  if (!gs.length) return;
  S.groups = gs;
  S.markOf = new Map();
  gs.forEach((g, j) => { for (const r of g.rows) S.markOf.set(r.a, j + 1); });
  if (document.fonts && document.fonts.load) {
    await Promise.race([document.fonts.load('900 22px "Zen Kaku Gothic New"', gs.map((g) => g.name).join('')).catch(() => {}), wait(1500)]);
  }
  $('.gs-head', G).textContent = `${md(S.t)}（${wd(S.t)}）にまとめて増えたもの`;
  $('.gs-list', G).innerHTML = cardsHTML();
  G.hidden = false;
  root.classList.add('has-groups');
  layoutLeft();
  fitCards();
  // 札は1枚ずつ 200ms ずらして 240ms で、行の印は同時に 120ms で出す
  const cards = $$('.card', G).filter((el) => !el.hidden);
  const fade = (el, delay, ms, dy) => ms && el.animate(
    [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: ms, delay, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' },
  );
  fade($('.gs-head', G), 0, dur(240), 0);
  cards.forEach((el, j) => fade(el, dur(200) * j, dur(240), 8));
  fade($('.gs-note', G), dur(200) * Math.max(0, cards.length - 1), dur(240), 0);
  for (const el of $$('.row', body)) {
    const r = ROWS[+el.dataset.k];
    const g = r ? markOf(r) : 0;
    if (!g || el.querySelector('.mk')) continue;
    el.classList.add(`g${g}`);
    el.insertAdjacentHTML('afterbegin', mkHTML(g));
    const m = el.firstElementChild;
    if (dur(120)) m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
  }
  stats.groupsAt = performance.now();
  root.dataset.groupsShown = '1';
}

function pickGroup(n) {
  if (!S.ready || !S.groups.length) return;
  clearTimeout(typing);
  S.group = S.group === n ? 0 : n;
  if (S.group && (S.query || q.value)) { S.query = ''; q.value = ''; }
  delete sheet.dataset.hl;
  setCards();
  reprint();
}

G.addEventListener('click', (e) => {
  const b = e.target.closest('.card');
  if (b) pickGroup(+b.dataset.g);
});
const hl = (e) => {
  const b = e.target.closest && e.target.closest('.card');
  if (b && !S.group) sheet.dataset.hl = b.dataset.g;
};
const unhl = (e) => {
  const b = e.target.closest && e.target.closest('.card');
  if (b && (!e.relatedTarget || !b.contains(e.relatedTarget))) delete sheet.dataset.hl;
};
G.addEventListener('mouseover', hl);
G.addEventListener('mouseout', unhl);
G.addEventListener('focusin', hl);
G.addEventListener('focusout', unhl);

/* ---------- 紙に刷る字 ---------- */

let ROWS = [];

function miniBars(r) {
  const s = seriesOf(r.a);
  const max = Math.max(1, ...s.map((v) => v || 0));
  let gray = '', red = '';
  s.forEach((v, j) => {
    const h = v ? Math.max(1, Math.round((v / max) * 12)) : 1;
    const rect = `<rect x="${2 + j * 4}" y="${12 - h}" width="3" height="${h}"/>`;
    if (j + 1 === r.day) red = rect; else gray += rect;
  });
  return `<svg viewBox="0 0 36 12" aria-hidden="true"><g fill="#141414" fill-opacity="0.45">${gray}</g><g fill="#D8321E">${red}</g></svg>`;
}

function delta(r) {
  if (r.isNew) return '<span class="new">新</span>';
  if (r.pct === null) return '';
  if (r.pct >= 20) return `<span class="up">▲${fmt(r.pct)}%</span>`;
  if (r.pct <= -20) return `<span class="down">▽${fmt(-r.pct)}%</span>`;
  return '';
}

function rowHTML(r) {
  const k = ROWS.push(r) - 1;
  const cls = r.rank <= 3 ? 'r1' : r.rank <= 10 ? 'r2' : 'r3';
  const g = markOf(r);
  return `<div class="row ${cls}${g ? ` g${g}` : ''}" data-k="${k}" role="button" tabindex="0" aria-expanded="false">${g ? mkHTML(g) : ''}<span class="c-rank">${r.rank}</span><span class="c-name">${esc(r.name)}</span>${miniBars(r)}<span class="c-v">${fmt(r.v)}</span><span class="c-d">${delta(r)}</span></div>`;
}

function stripe(text) {
  // 日付から縞を作る（FNV-1a で字を混ぜ、棒と隙間の幅を 1〜4 にする）
  let h = 2166136261 >>> 0;
  const mix = (v) => { h ^= v & 255; h = Math.imul(h, 16777619) >>> 0; };
  for (const ch of text) { const c = ch.codePointAt(0); mix(c); mix(c >> 8); mix(c >> 16); }
  const ws = [2, 1, 1, 1];
  for (let i = 0; i < 44; i++) { mix(i); ws.push(1 + (h & 3), 1 + ((h >>> 2) & 3)); }
  ws.push(1, 1, 2);
  const T = ws.reduce((a, b) => a + b, 0);
  let x = 0;
  const stops = ws.map((w, i) => {
    const a = ((x / T) * 100).toFixed(3), b = (((x + w) / T) * 100).toFixed(3);
    x += w;
    return `${i % 2 ? 'transparent' : '#141414'} ${a}% ${b}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

const COLHEAD = '<div class="colhead" aria-hidden="true"><span class="c-rank">順位</span><span>記事</span><span>8日間</span><span class="c-v">回数</span><span class="c-d">前の日から</span></div><p class="colnote">新＝前の日は上位1000の外</p>';

// 紙の鎖のいちばん古い日（数のある日）
function oldestDay() {
  for (let i = 1; i <= LATEST; i++) if (S.lists[i]) return i;
  return LATEST;
}

function pieceHTML(d, first) {
  const rows = rowsFor(d);
  const sum = rows.reduce((s, r) => s + r.v, 0);
  let h = `<section class="piece grp" data-day="${d.i}">`;
  if (!first) {
    h += `<div class="tear"></div><div class="paper d-head"><p class="p-date">${fullDate(d.t)}</p><p class="p-sub">${SUB}</p><hr class="rule">${COLHEAD}<hr class="rule rule-last"></div>`;
  }
  h += '<div class="paper rows">';
  h += rows.length ? rows.map(rowHTML).join('') : '<p class="empty">この日の上位200には、前の日の上位1000の外だった記事はありません</p>';
  h += '</div>';
  h += `<div class="paper foot"><hr class="rule"><div class="sum"><span>小計 ${rows.length}点</span><strong>${fmt(sum)}<small>回</small></strong></div>`;
  if (d.newCount !== null) h += `<p class="newline">うち前の日は上位1000の外だった記事 ${d.newCount}点</p>`;
  if (d.i === oldestDay() && S.days[0] >= MIN) {
    h += `<p class="more"><a href="${esc(urlFor(S.days[0]))}" data-go>この前の日を刷る（${md(S.days[0])}）</a></p>`;
  }
  h += `<div class="stripe" style="background-image:${stripe(fullDate(d.t))}"></div></div><div class="cut"></div></section>`;
  return h;
}

function groupHTML(g) {
  const rows = sortRows(g.rows);
  const sum = rows.reduce((s, r) => s + r.v, 0);
  let h = `<section class="piece grp" data-day="${LATEST}"><div class="paper rows">`;
  h += rows.length ? rows.map(rowHTML).join('') : '<p class="empty">この組には、前の日の上位1000の外だった記事はありません</p>';
  h += `</div><div class="paper foot"><hr class="rule"><div class="sum"><span>合計 ${rows.length}点</span><strong>${fmt(sum)}<small>回</small></strong></div>`;
  h += `<div class="stripe" style="background-image:${stripe(g.name)}"></div></div><div class="cut"></div></section>`;
  return { html: h, sum };
}

function checkedDays() {
  const out = [];
  for (let i = LATEST; i >= 1; i--) if (S.D.has(i)) out.push(i);
  return out;
}

function searchResult() {
  const ws = norm(S.query).split(/\s+/).filter(Boolean);
  const groups = [];
  let total = 0, count = 0;
  for (const i of checkedDays()) {
    const d = S.D.get(i);
    const hits = rowsFor(d).filter((r) => ws.every((w) => r.n.includes(w)));
    if (!hits.length) continue;
    const sum = hits.reduce((s, r) => s + r.v, 0);
    groups.push({ d, hits, sum });
    total += sum;
    count += hits.length;
  }
  return { groups, total, count, days: checkedDays() };
}

function searchHTML(res) {
  if (!res.groups.length) {
    return `<section class="piece"><div class="paper"><p class="empty">この8日間の上位200には入っていません</p><div class="stripe" style="background-image:${stripe(S.query)}"></div><div style="height:14px"></div></div><div class="cut"></div></section>`;
  }
  let h = '<section class="piece">';
  for (const g of res.groups) {
    h += `<div class="paper grp" data-day="${g.d.i}"><p class="g-date">${fullDate(g.d.t)}</p>${g.hits.map(rowHTML).join('')}`;
    h += `<div class="sub-sum"><span>小計 ${g.hits.length}点</span><strong>${fmt(g.sum)}<small>回</small></strong></div><hr class="rule"></div>`;
  }
  h += `<div class="paper foot"><div class="sum"><span>合計 ${res.count}点</span><strong>${fmt(res.total)}<small>回</small></strong></div><div class="stripe" style="background-image:${stripe(S.query)}"></div></div><div class="cut"></div></section>`;
  return h;
}

function setHead() {
  const hd = $('#h-date'), hs = $('#h-sub');
  const t = S.days[LATEST];
  if (S.query) {
    const ds = checkedDays();
    const a = S.days[ds[ds.length - 1]], b = S.days[ds[0]];
    hd.textContent = ds.length > 1 ? `${fullDate(a)}〜${md(b)}（${wd(b)}）` : fullDate(b);
    hs.textContent = `日本語版 Wikipedia　${ds.length}日間の上位200から`;
  } else if (S.group) {
    hd.textContent = fullDate(t);
    hs.textContent = `カテゴリ「${S.groups[S.group - 1].name}」の記事　${md(t)}（${wd(t)}）`;
  } else {
    hd.textContent = fullDate(t);
    hs.textContent = SUB;
  }
}

let groupSum = 0;
function render() {
  ROWS = [];
  S.open = null;
  if (S.query) {
    S.search = searchResult();
    body.innerHTML = searchHTML(S.search);
  } else if (S.group) {
    S.search = null;
    const r = groupHTML(S.groups[S.group - 1]);
    groupSum = r.sum;
    body.innerHTML = r.html;
  } else {
    S.search = null;
    if (!S.printed.length) S.printed = [LATEST];
    body.innerHTML = S.printed.map((i, n) => pieceHTML(S.D.get(i), n === 0)).join('');
  }
  setHead();
  fitNames(body);
  invalidate();
}

// 1〜3位の名前は 28px。入らなければ 20px まで下げ、それでも入らなければ「…」で切る
function fitNames(scope) {
  for (const el of $$('.row.r1 .c-name', scope)) {
    el.style.fontSize = '';
    let fs = 28;
    while (fs > 20 && el.scrollWidth > el.clientWidth + 0.5) { fs -= 1; el.style.fontSize = `${fs}px`; }
  }
}

function appendPiece(i) {
  const tmp = document.createElement('div');
  tmp.innerHTML = pieceHTML(S.D.get(i), false);
  const el = tmp.firstElementChild;
  body.append(el);
  S.printed.push(i);
  fitNames(el);
  invalidate();
  // 前の日の1〜3位の字がまだ読めていなければ、読めてから測り直す
  if (document.fonts && document.fonts.load) {
    const top = S.D.get(i).rows.slice(0, 3).map((r) => r.name).join('');
    document.fonts.load('700 28px "M PLUS 1 Code"', top).then(() => { fitNames(el); invalidate(); }, () => {});
  }
}

function nextDay() {
  const last = S.printed[S.printed.length - 1] ?? LATEST + 1;
  for (let i = last - 1; i >= 1; i--) {
    if (!S.lists[i]) continue;
    return S.D.has(i) ? i : null;
  }
  return null;
}

function maybeAppend() {
  if (!S.ready || S.query || S.group) return;
  for (let guard = 0; guard < 8; guard++) {
    if (sheet.getBoundingClientRect().bottom - innerHeight >= 1500) return;
    const n = nextDay();
    if (n === null) return;
    appendPiece(n);
  }
}

/* ---------- 右の合計（桁ごとに縦に回る） ---------- */

let shown = null;
function setTotal(n, animate = true) {
  const s = fmt(n);
  if (s === shown) return;
  const prev = shown;
  shown = s;
  const same = prev && prev.length === s.length && [...prev].every((c, k) => (c === ',') === (s[k] === ','));
  if (!same) {
    numEl.innerHTML = [...s].map((c) => (c === ',' ? '<span class="dt">,</span>'
      : `<span class="dg"><span class="strip">${[...'0123456789'].map((x) => `<span>${x}</span>`).join('')}</span></span>`)).join('');
  }
  fitTotal();
  const strips = $$('.strip', numEl);
  const digits = [...s].filter((c) => c !== ',');
  const D = animate ? dur(600) : 0;
  // 桁が組み替わるときは、空の所から回し入れる（回り始めに 0 が並んで見えないように）
  if (!same) { for (const st of strips) { st.style.transition = 'none'; st.style.transform = 'translateY(1.2em)'; } void numEl.offsetWidth; }
  strips.forEach((st, k) => {
    st.style.transition = D ? `transform ${D}ms cubic-bezier(0.2, 0.7, 0.2, 1) ${k * 40}ms` : 'none';
    st.style.transform = `translateY(${-1.2 * digits[k]}em)`;
  });
  numEl.setAttribute('aria-label', s);
}

// 右の幅に入らない桁数なら字を小さくする
function fitTotal() {
  totalEl.style.fontSize = '';
  const base = parseFloat(getComputedStyle(totalEl).fontSize);
  const s = shown || '0';
  const em = [...s].reduce((a, c) => a + (c === ',' ? 0.3 : 0.6), 0);
  const unit = $('.m-unit').getBoundingClientRect().width + 6;
  const cs = getComputedStyle(meter);
  const W = meter.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const need = base * em + unit;
  if (need > W) totalEl.style.fontSize = `${Math.floor(((W - unit) / em) * 10) / 10}px`;
}

function setNote(t) { $('#m-note').textContent = t; }
const noteDay = (d) => (d.rows.length < 200 ? `この日の上位${d.rows.length}点が読まれた回数` : NOTE_DAY);

function updateMeter(animate = true) {
  if (S.group) {
    totalEl.classList.remove('is-wait');
    setTotal(groupSum, animate);
    setNote('この組が読まれた回数');
    return;
  }
  if (!(S.query && S.search) && !S.D.has(S.curDay)) return;
  totalEl.classList.remove('is-wait');
  if (S.query && S.search) {
    setTotal(S.search.total, animate);
    setNote(`当たった記事が${S.search.days.length}日間に読まれた回数`);
  } else if (S.D.has(S.curDay)) {
    const d = S.D.get(S.curDay);
    setTotal(d.total, animate);
    setNote(noteDay(d));
  }
}

/* ---------- 目盛りと「いま」 ---------- */

function buildTicks() {
  const ol = $('#ticks');
  let h = '';
  for (let k = 0; k < 8; k++) {
    const i = LATEST - k;
    const t = S.days[i];
    const top = `top:${(k / 8) * 100}%`;
    const st = S.state[i];
    if (st === 'pre') { h += `<li class="tick is-pre" style="${top}"></li>`; continue; }
    if (st === 'none' || st === 'fail') {
      h += `<li class="tick is-none" style="${top}"><button type="button" disabled aria-disabled="true">${slash(t)} 数なし</button></li>`;
      continue;
    }
    const wait = !S.D.has(i);
    h += `<li class="tick${wait ? ' is-wait' : ''}" style="${top}"><button type="button" data-i="${i}"${wait ? ' aria-disabled="true"' : ''}>${t ? `${slash(t)} ${wd(t)}` : ''}</button></li>`;
  }
  h += '<li class="tick end" style="top:100%"></li>';
  ol.innerHTML = h;
  const yr = $('#r-year');
  const y = U(S.days[LATEST]).getUTCFullYear();
  yr.hidden = y === U(TODAY).getUTCFullYear();
  yr.textContent = String(y);
}

let gcache = null;
function invalidate() { gcache = null; }
function groups() {
  if (!gcache) {
    const y0 = scrollY;
    gcache = $$('.grp', sheet).map((el) => {
      const b = el.getBoundingClientRect();
      return { el, i: +el.dataset.day, top: b.top + y0, h: b.height, rows: null };
    });
  }
  return gcache;
}
function rowTops(g) {
  if (!g.rows) {
    const y0 = scrollY;
    g.rows = $$('.row', g.el).map((r) => [r.getBoundingClientRect().top + y0, ROWS[+r.dataset.k]]);
  }
  return g.rows;
}
function lineView() { return side.matches ? mouth.getBoundingClientRect().top + 7 : innerHeight * 0.3; }

function updateNow() {
  const gs = groups();
  if (!gs.length) return;
  const y = scrollY + lineView() + 1;
  let g = gs[0];
  for (const x of gs) if (x.top <= y) g = x;
  const frac = clamp((y - g.top) / Math.max(1, g.h), 0, 1);
  const k = LATEST - g.i;
  const L = ruler.clientHeight;
  mark.style.transform = `translateY(${(((k + frac) / 8) * L).toFixed(1)}px)`;
  const rt = rowTops(g);
  let rank = rt.length ? rt[0][1].rank : 1;
  let lo = 0, hi = rt.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rt[m][0] <= y) { rank = rt[m][1].rank; lo = m + 1; } else hi = m - 1; }
  nowEl.textContent = `いま ${slash(S.days[g.i])} ${rank}位`;
  if (!S.query && !S.group && g.i !== S.curDay) { S.curDay = g.i; updateMeter(true); }
}

let scrollAnim = 0;
function scrollToY(y, ms) {
  cancelAnimationFrame(scrollAnim);
  const y0 = scrollY;
  const max = root.scrollHeight - innerHeight;
  const to = clamp(y, 0, max);
  if (!ms) { scrollTo(0, to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = clamp((t - t0) / ms, 0, 1);
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    scrollTo(0, y0 + (to - y0) * e);
    if (p < 1) scrollAnim = requestAnimationFrame(step);
  };
  scrollAnim = requestAnimationFrame(step);
}

function jump(i) {
  if (!S.ready || !S.D.has(i)) return;
  if (S.group) { S.group = 0; setCards(); reprint(); }
  if (!S.query) {
    for (let guard = 0; guard < 8 && !S.printed.includes(i); guard++) {
      const n = nextDay();
      if (n === null) break;
      appendPiece(n);
    }
  }
  const g = groups().find((x) => x.i === i);
  if (!g) return;
  const to = !S.query && i === S.printed[0] ? 0 : g.top - lineView();
  scrollToY(to, dur(500));
}

/* ---------- 行を開く ---------- */

function panelHTML(r) {
  const s = seriesOf(r.a);
  const max = Math.max(1, ...s.map((v) => v || 0));
  let gray = '', red = '', labels = '';
  s.forEach((v, j) => {
    const i = j + 1;
    const h = v ? Math.max(1, Math.round((v / max) * 48)) : 1;
    const rect = `<rect x="${j * 56 + 8}" y="${48 - h}" width="40" height="${h}"/>`;
    if (i === r.day) red = rect; else gray += rect;
    const st = S.state[i];
    const word = st === 'pre' ? '' : st === 'none' || st === 'fail' ? '数なし' : v ? fmt(v) : '圏外';
    labels += `<span${i === r.day ? ' class="is-day"' : ''}><b>${S.days[i] && st !== 'pre' ? slash(S.days[i]) : ''}</b><i>${word}</i></span>`;
  });
  return `<div class="pn-head"><span class="pn-name">${esc(r.name)}</span><a class="pn-link" href="${esc(wikiURL(r.a))}" target="_blank" rel="noopener">Wikipedia で読む</a></div>`
    + `<svg class="pn-bars" viewBox="0 0 448 48" preserveAspectRatio="none" aria-hidden="true"><g fill="#141414" fill-opacity="0.45">${gray}</g><g fill="#D8321E">${red}</g></svg>`
    + `<div class="pn-labels">${labels}</div>`;
}

function closeOpen(now) {
  const o = S.open;
  if (!o) return;
  S.open = null;
  o.row.classList.remove('is-open');
  o.row.setAttribute('aria-expanded', 'false');
  o.panel.classList.remove('is-open');
  const p = o.panel;
  if (now || !dur(200)) p.remove();
  else setTimeout(() => { p.remove(); invalidate(); updateNow(); }, 210);
}

function toggle(row) {
  const prev = S.open;
  closeOpen(false);
  if (prev && prev.row === row) return;
  const r = ROWS[+row.dataset.k];
  if (!r) return;
  const p = document.createElement('div');
  p.className = 'panel';
  p.innerHTML = panelHTML(r);
  row.after(p);
  row.classList.add('is-open');
  row.setAttribute('aria-expanded', 'true');
  void p.offsetHeight;
  p.classList.add('is-open');
  S.open = { row, panel: p };
  invalidate();
  setTimeout(() => { invalidate(); updateNow(); }, dur(200) + 20);
}

/* ---------- 刷り出し・落ちる・刷り直し ---------- */

function emerge(ms, steps) {
  // しまっておいた紙は、刷り出しの最初のコマから見せる（同じ処理の中で外すので、出た姿は描かれない）
  sheet.classList.remove('is-hold');
  const top = track.getBoundingClientRect().top;
  const D = Math.max(0, Math.min(sheet.offsetHeight, innerHeight - top));
  if (!D || !ms) return Promise.resolve();
  const a = sheet.animate([{ transform: `translateY(${-D}px)` }, { transform: 'translateY(0)' }], { duration: ms, easing: `steps(${steps}, end)` });
  return a.finished.catch(() => {});
}

// 行の所だけ、上から刷っていく（紙色の覆いを下へ送る）
function reveal(ms, steps) {
  const b = body.getBoundingClientRect();
  const H = Math.max(0, Math.min(innerHeight, b.bottom) - Math.max(b.top, 0));
  if (H < 4 || !ms) return Promise.resolve();
  const c = document.createElement('div');
  c.className = 'cover';
  c.style.top = `${Math.max(0, -b.top)}px`;
  c.style.height = `${H}px`;
  body.append(c);
  const a = c.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${H}px)` }], { duration: ms, easing: `steps(${steps}, end)`, fill: 'forwards' });
  return a.finished.catch(() => {}).then(() => c.remove());
}

// 見えている紙を写さずに外して、その場から落とす。新しい空の紙を同じ所に置く。
function detach() {
  const old = body;
  const fresh = document.createElement('div');
  fresh.className = 'body';
  fresh.id = 'body';
  const r = old.getBoundingClientRect();
  const top = Math.max(r.top, side.matches ? lineView() : 0), bottom = Math.min(innerHeight, r.bottom);
  const kids = [...old.children];
  const vis = kids.filter((el) => { const b = el.getBoundingClientRect(); return b.bottom >= top && b.top <= bottom; });
  old.replaceWith(fresh);
  body = fresh;
  if (bottom - top < 12 || !vis.length) return null;
  const firstTop = vis[0].getBoundingClientRect().top;
  for (const el of kids) if (!vis.includes(el)) el.remove();
  const sp = document.createElement('div');
  sp.style.height = `${firstTop - r.top}px`;
  old.prepend(sp);
  vis[0].style.marginTop = '0';
  old.removeAttribute('id');
  Object.assign(old.style, { position: 'absolute', left: '0', width: '100%', top: `${r.top - top}px` });
  const wrap = document.createElement('div');
  wrap.className = 'fall';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.inert = true;
  Object.assign(wrap.style, { left: `${r.left}px`, top: `${top}px`, width: `${r.width}px`, height: `${bottom - top}px` });
  wrap.append(old);
  document.body.append(wrap);
  return wrap;
}

function fall(wrap) {
  if (!wrap) return Promise.resolve();
  const a = wrap.animate(
    [{ transform: 'translateY(0)' }, { transform: `translateY(${Math.round(innerHeight * 1.05)}px)` }],
    { duration: dur(350), easing: 'cubic-bezier(0.55, 0, 1, 0.45)', fill: 'forwards' },
  );
  return a.finished.catch(() => {}).then(() => wrap.remove());
}

let printing = 0;
async function reprint() {
  if (!S.ready) return;
  printing++;
  root.dataset.settled = '0';
  closeOpen(true);
  const anim = !reduce.matches;
  // 送った先にいたら、紙の頭（さがす・札）へ戻してから刷り直す
  const piece = detach();
  if (!anim && piece) piece.remove();
  if (scrollY > 0) scrollTo(0, 0);
  S.printed = [LATEST];
  S.curDay = LATEST;
  render();
  updateMeter(true);
  updateNow();
  if (anim) {
    fall(piece);
    await reveal(600, 16);
  }
  maybeAppend();
  updateNow();
  if (--printing === 0) root.dataset.settled = '1';
}

/* ---------- 日付で刷る（ページごと ?d= へ移る） ---------- */

const urlFor = (t) => (t === YEST ? location.pathname : `${location.pathname}?d=${ymd(t, '-')}`);

function toT(y, m, d) {
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null;
  const x = new Date(0);
  x.setUTCFullYear(+y, +m - 1, +d);
  if (x.getUTCFullYear() !== +y || x.getUTCMonth() !== +m - 1 || x.getUTCDate() !== +d) return null;
  return x.getTime();
}

// URL の ?d=。形の違う日付は ? なしと同じに扱う（URL からも外す）。きのうは ? なしの URL にそろえる。
function parseD() {
  let v = null;
  try { v = new URLSearchParams(location.search).get('d'); } catch (e) { v = null; }
  if (v === null) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const t = m ? toT(m[1], m[2], m[3]) : null;
  if (t === null) {
    history.replaceState(null, '', location.pathname);
    return undefined;
  }
  if (t === YEST) history.replaceState(null, '', location.pathname);
  return t;
}

let leaving = false;
async function go(url) {
  if (leaving) return;
  leaving = true;
  closeOpen(true);
  // 今の紙を口の下へ落としてから移る
  if (dur(350) && !sheet.classList.contains('is-hold')) {
    const a = sheet.animate(
      [{ transform: 'translateY(0)' }, { transform: `translateY(${Math.round(innerHeight * 1.05)}px)` }],
      { duration: 350, easing: 'cubic-bezier(0.55, 0, 1, 0.45)', fill: 'forwards' },
    );
    await a.finished.catch(() => {});
  }
  location.assign(url);
}
addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

const ins = [$('#dy'), $('#dm'), $('#dd')];
function setPick(t) {
  ins[0].value = String(U(t).getUTCFullYear());
  ins[1].value = String(U(t).getUTCMonth() + 1).padStart(2, '0');
  ins[2].value = String(U(t).getUTCDate()).padStart(2, '0');
}
ins.forEach((el, k) => {
  const clean = () => {
    const v = el.value.normalize('NFKC').replace(/\D/g, '').slice(0, el.maxLength);
    if (v !== el.value) el.value = v;
    if (v.length === el.maxLength && k < 2 && document.activeElement === el) { ins[k + 1].focus(); ins[k + 1].select(); }
  };
  el.addEventListener('input', (e) => { if (!e.isComposing) clean(); });
  el.addEventListener('compositionend', clean);
  el.addEventListener('focus', () => el.select());
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !el.value && k > 0) { e.preventDefault(); ins[k - 1].focus(); }
  });
});

const nav = $('#nav');
const nvPrev = $('#nv-prev'), nvNext = $('#nv-next'), nvCopy = $('#nv-copy'), nvBack = $('#nv-back'), nvMsg = $('#nv-msg');
let flashTimer = 0;
function flash(msg) {
  clearTimeout(flashTimer);
  nvMsg.textContent = msg;
  nav.classList.add('is-msg');
  nvMsg.hidden = false;
  flashTimer = setTimeout(() => { nav.classList.remove('is-msg'); nvMsg.hidden = true; }, 2400);
}

let navT = { prev: null, next: null };
window.__yonda.navTo = () => ({ prev: navT.prev === null ? null : urlFor(navT.prev), next: navT.next === null ? null : urlFor(navT.next) });
function setNav(t, latestPage) {
  const prev = t >= TODAY ? YEST : t - DAY;
  const next = t < MIN ? MIN : t + DAY;
  navT = { prev, next };
  nvPrev.disabled = prev < MIN;
  nvNext.disabled = latestPage || next >= TODAY;
  nvBack.hidden = !(S.hasD && t !== YEST);
}

$('#pick').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = toT(ins[0].value, ins[1].value, ins[2].value);
  if (t === null) { flash(MSG.bad); return; }
  if (t < MIN) { flash(MSG.pre); return; }
  if (t >= TODAY) { flash(MSG.future); return; }
  go(urlFor(t));
});
nvPrev.addEventListener('click', () => { if (navT.prev !== null) go(urlFor(navT.prev)); });
nvNext.addEventListener('click', () => { if (navT.next !== null) go(urlFor(navT.next)); });
nvBack.addEventListener('click', () => go(location.pathname));
nvCopy.addEventListener('click', async () => {
  const u = location.href;
  let ok = false;
  try { await navigator.clipboard.writeText(u); ok = true; } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = u;
      ta.setAttribute('readonly', '');
      Object.assign(ta.style, { position: 'fixed', left: '0', top: '0', opacity: '0' });
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e2) { ok = false; }
  }
  if (!ok) return;
  nvCopy.textContent = '写しました';
  setTimeout(() => { nvCopy.textContent = 'リンクを写す'; }, 1200);
});

/* ---------- さがす・並べ方 ---------- */

let typing = 0;
function applyQuery(v) {
  clearTimeout(typing);
  const nv = v.trim();
  if (norm(nv) === norm(S.query) && !S.group) return;
  S.query = nv;
  if (S.group) { S.group = 0; setCards(); }
  reprint();
}
q.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => applyQuery(q.value), 400); });
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyQuery(q.value); }
  else if (e.key === 'Escape') { q.value = ''; applyQuery(''); }
});
q.addEventListener('search', () => { if (!q.value) applyQuery(''); });

for (const b of $$('.tab')) {
  b.addEventListener('click', () => {
    const m = b.dataset.m;
    if (m === S.mode || !S.ready) return;
    S.mode = m;
    for (const x of $$('.tab')) x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    reprint();
  });
}

sheet.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-go]');
  if (a) { e.preventDefault(); go(a.getAttribute('href')); return; }
  if (e.target.closest('a, input, button')) return;
  const row = e.target.closest('.row');
  if (row && body.contains(row)) toggle(row);
});
sheet.addEventListener('keydown', (e) => {
  const row = e.target.closest && e.target.closest('.row');
  if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  toggle(row);
});

$('#ticks').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b) jump(+b.dataset.i);
});

let raf = 0;
addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; maybeAppend(); updateNow(); });
}, { passive: true });
addEventListener('resize', () => { invalidate(); fitTotal(); layoutLeft(); fitCards(); updateNow(); });

/* ---------- 題・説明・左の欄の割り付け ---------- */

// 日付は行の途中で割らない（「2015年7月」と「1日」に分かれないように）
const leadHTML = (t, short) => `日本語版 Wikipedia で<span class="nw">${md(t)}（${wd(t)}）</span>に読まれた記事を、多い順に1本のレシートにしました。1行が1記事、${short ? '右の数字が回数です。' : '右の数字が読まれた回数です。'}日付は<span class="nw">2015年7月1日</span>から選べます。`;
const setLead = (t, short) => { $('#lead').innerHTML = leadHTML(t, short); };

function setTitle(t) {
  const jst = Math.floor((Date.now() + 9 * 3600e3) / DAY);
  const diff = jst - Math.floor(t / DAY);
  const y = U(t).getUTCFullYear();
  const t1 = diff === 1 ? 'きのう、' : diff === 2 ? 'おととい、' : `${md(t)}、`;
  $('#t1').textContent = t1;
  const yr = $('#year');
  yr.hidden = !(diff >= 3);
  yr.textContent = `${y}年`;
  document.title = `${diff === 1 || diff === 2 ? t1 : `${y}年${md(t)}、`}日本が読んだもの。`;
  setLead(t, false);
  $('#h-date').textContent = fullDate(t);
}

const lines = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));

// 説明が3行を超えるなら2文目を縮める。札と注が出典（と左に置いた合計）に重なるなら、
// 注を1文目に、間を詰める、札を低くする、注を外す、札を後ろから外す、の順に引く（注はなるべく残す）。
function layoutLeft() {
  if (S.t === null) return;
  const lead = $('#lead');
  lead.classList.remove('is-loose');
  setLead(S.t, false);
  if (side.matches && lines(lead) > 3) {
    setLead(S.t, true);
    // 句で割ると1行増える幅（1280 など）では、字の間で割る（日付は割らない）
    const n = lines(lead);
    lead.classList.add('is-loose');
    if (lines(lead) >= n) lead.classList.remove('is-loose');
  }
  if (G.hidden) return;
  const note = $('.gs-note', G);
  note.textContent = G_NOTE;
  note.hidden = false;
  G.classList.remove('is-snug', 'is-tight');
  for (const c of $$('.card', G)) c.hidden = false;
  if (!side.matches) { G.style.top = ''; return; }
  const ctlB = $('#ctl').getBoundingClientRect().bottom;
  const place = (gap) => { G.style.top = `${Math.round(ctlB + gap)}px`; };
  place(17);
  const gr = G.getBoundingClientRect();
  let limit = $('.src').getBoundingClientRect().top - 12;
  const m = meter.getBoundingClientRect();
  if (m.left < gr.right && m.right > gr.left) limit = Math.min(limit, m.top - 16);
  const fits = () => G.getBoundingClientRect().bottom <= limit;
  const steps = [
    ['full', () => {}],
    ['note1', () => { note.textContent = G_NOTE1; }],
    ['snug', () => { G.classList.add('is-snug'); place(10); }],
    ['tight', () => { G.classList.add('is-tight'); }],
    ['noNote', () => { note.hidden = true; }],
  ];
  for (const [name, f] of steps) {
    f();
    stats.leftFit = name;
    if (fits()) return;
  }
  const cs = $$('.card', G);
  for (let k = cs.length - 1; k >= 1 && !fits(); k--) { cs[k].hidden = true; stats.leftFit = `cards${k}`; }
}

/* ---------- 書体 ---------- */

async function fontsBase() {
  if (!document.fonts || !document.fonts.load) return;
  await Promise.race([
    Promise.all([
      document.fonts.load('900 56px "Zen Kaku Gothic New"', 'きのう、おととい日本が読んだもの。0123456789,年月日回刷る'),
      document.fonts.load('400 15px "Zen Kaku Gothic New"', '日本語版 Wikipedia で月日（日月火水木金土）に読まれた記事を、多い順に1本のレシートにしました。行が右の数字が回数です。付は2015年7から選べ合計この上位200出典は公開データ閲覧と世界標準時間朝9から翌成人向け事件外しています当たったまとめ＝前の2倍以上に増えた（新を含む）3本入っているカテゴリ名前'),
      document.fonts.load('500 20px "M PLUS 1 Code"', 'さがす：気になる言葉前の日は圏外増えた順減った順読まれた順位記事8日間回数から新＝上位1000の外日本語版 Wikipedia年月日（）〜◀▶次リンクを写すきのうに戻る写しましたその付ありません数があるのは2015年7月1日からですまだ来ていない出て刷るカテゴリの点この組数なし「」'),
      document.fonts.load('700 20px "M PLUS 1 Code"', '0123456789,年月日（）日月火水木金土小計合計点回▲%新日付'),
      document.fonts.load('500 13px "Roboto Mono"', '0123456789/ '),
    ]).catch(() => {}),
    wait(2500),
  ]);
}
async function fontsFor(d) {
  if (!document.fonts || !document.fonts.load) return;
  const top = d.rows.slice(0, 10).map((r) => r.name).join('');
  const all = d.rows.map((r) => r.name).join('');
  await Promise.race([
    Promise.all([document.fonts.load('700 28px "M PLUS 1 Code"', top), document.fonts.load('500 15px "M PLUS 1 Code"', all)]).catch(() => {}),
    wait(1500),
  ]);
}

/* ---------- 始め ---------- */

function setLeft(t, latestPage) {
  S.t = t;
  setTitle(t);
  setPick(t);
  setNav(t, latestPage);
  layoutLeft();
}

function fail(t) {
  if (t !== undefined) setLeft(t, false);
  root.classList.add('is-on');
  $('#h-date').textContent = '数を取れませんでした';
  body.innerHTML = '<section class="piece"><div class="paper"><p class="empty">Wikimedia から数を取れませんでした。少し置いてから開き直してください。</p></div><div class="cut"></div></section>';
  root.dataset.ready = 'fail';
}

// 刷れない日: 紙は口から出して、頭に打った日付を刷る。合計は出さない。前後のボタンは効く。
async function message(t, msg) {
  setLeft(t, false);
  sheet.classList.add('is-msg', 'is-hold');
  meter.classList.add('is-none');
  q.disabled = true;
  for (const b of $$('.tab')) b.disabled = true;
  $('#h-date').textContent = fullDate(t);
  $('#h-sub').textContent = SUB;
  body.innerHTML = `<section class="piece"><div class="paper"><p class="empty">${esc(msg)}</p><div class="stripe" style="background-image:${stripe(fullDate(t))}"></div><div style="height:14px"></div></div><div class="cut"></div></section>`;
  root.classList.add('is-on');
  layoutLeft();
  await emerge(dur(900), 24);
  root.dataset.ready = 'msg';
  root.dataset.settled = '1';
  stats.message = msg;
}

async function rest() {
  // 残りの7日の題を1つにまとめて重複を除き、40本ずつ同時に3本で確かめる（新しい日の題から先に）
  const order = [];
  for (let i = LATEST - 1; i >= 1; i--) if (S.lists[i]) for (const c of candidatesOf(S.lists[i], S.lists[i - 1])) order.push(c.article);
  const all = new Set(order);
  for (const c of candidatesOf(S.lists[LATEST], S.lists[LATEST - 1])) all.add(c.article);
  stats.uniqueTitles = all.size;
  const t0 = performance.now();
  const tryBuild = () => {
    let changed = false;
    for (let i = LATEST - 1; i >= 1; i--) {
      if (!S.lists[i] || S.D.has(i)) continue;
      if (!candidatesOf(S.lists[i], S.lists[i - 1]).every((c) => hasVerdict(c.article))) continue;
      buildDay(i);
      stats.perDay[slash(S.days[i])] = { ms: Math.round(performance.now() - t0) };
      changed = true;
    }
    if (!changed) return;
    buildTicks();
    // 紙が出きるまでは、目盛りだけ替える（足すのと「いま」は出たあとに start がやる）
    if (!S.ready) return;
    if (S.query) {
      // さがしている間に確かめ終わった日は、動かさずに足す
      const y = scrollY;
      render();
      scrollTo(0, y);
      updateMeter(true);
    }
    maybeAppend();
    updateNow();
  };
  const r = await checkTitles(order, { size: 40, onBatch: tryBuild });
  tryBuild();
  stats.restAsked = r.asked;
  stats.restStored = r.stored;
  stats.restBatches = r.batches;
  stats.restDoneAt = performance.now();
  root.dataset.allChecked = '1';
  await showGroups();
}

async function start() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  scrollTo(0, 0);
  const fp = fontsBase();
  const end = parseD();
  S.hasD = end !== undefined && end !== YEST;
  if (end !== undefined && (end < MIN || end >= TODAY)) {
    await fp;
    await message(end, end < MIN ? MSG.pre : MSG.future);
    return;
  }
  let got;
  const tA = performance.now();
  try { got = await loadDays(end); } catch (e) { await fp; fail(end ?? YEST); return; }
  stats.topMs = performance.now() - tA;
  S.days = got.days;
  S.lists = got.lists;
  S.state = got.state;
  S.views = got.lists.map((l) => (l ? new Map(l.map((a) => [a.article, a.views])) : null));
  const t = S.days[LATEST];
  if (S.state[LATEST] === 'none') {
    await fp;
    await message(t, t >= TODAY - 2 * DAY ? MSG.notyet : MSG.none);
    return;
  }
  setLeft(t, end === undefined || end === YEST);
  buildTicks();

  const tB = performance.now();
  const latestP = checkTitles(candidatesOf(S.lists[LATEST], S.lists[LATEST - 1]).map((c) => c.article))
    .then((r) => { stats.catLatestMs = performance.now() - tB; stats.catLatestAsked = r.asked; const d = buildDay(LATEST); return fontsFor(d); });

  await fp;
  layoutLeft();
  // 紙は刷り出すまで口の中、合計は足し終わるまで出さない（頭の刷り出しは1回だけ）
  sheet.classList.add('is-hold');
  totalEl.classList.add('is-wait');
  root.classList.add('is-on');
  shown = null;

  // 2秒を過ぎても確かめが終わらなければ、紙の頭だけ先に出す
  const early = wait(Math.max(0, 2000 - performance.now())).then(() => 'head');
  const first = await Promise.race([latestP.then(() => 'rows'), early]);
  if (first === 'head') {
    stats.earlyHead = true;
    await emerge(dur(900), 24);
    await latestP;
  }
  S.printed = [LATEST];
  render();
  stats.rowsAt = performance.now();
  // 残りの7日の確かめは、紙が出るのを待たずに始める（札が早く出る）
  rest();
  buildTicks();
  ruler.hidden = false;
  updateMeter(true);
  updateNow();
  if (first === 'head') await reveal(dur(600), 16);
  else await emerge(dur(900), 24);
  stats.printedAt = performance.now();
  S.ready = true;
  root.dataset.ready = '1';
  root.dataset.settled = '1';
  buildTicks();
  if (q.value.trim()) applyQuery(q.value);
  invalidate();
  maybeAppend();
  updateNow();
}

// 確かめの道具から合計の幅を試す（桁の多い日に右の幅に入るか）
window.__yonda.tryTotal = (n) => {
  const keep = shown;
  setTotal(n, false);
  const m = meter.getBoundingClientRect();
  const t = totalEl.getBoundingClientRect();
  const out = { text: shown, fontSize: parseFloat(getComputedStyle(totalEl).fontSize), meterRight: m.right, totalRight: t.right, overflow: Math.max(0, Math.round(t.right - m.right)), width: Math.round(t.width), meterWidth: Math.round(m.width) };
  shown = null;
  setTotal(+keep.replace(/,/g, ''), false);
  return out;
};

requestAnimationFrame(() => setTimeout(start, 0));
