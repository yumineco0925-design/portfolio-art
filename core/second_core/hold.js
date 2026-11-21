// hold.js — 「一秒だと思う長さ」を受け取る。見た目は持たない。要素（本物の button）は外から渡す。
//
// 道は2つ。
//   hold   押し続け。Space か Enter のキー、マウスの左ボタン、指、ペン。押した時刻と離した時刻を取る
//   twice  2回押し。押し続けられない人のための道。1回目に押した時刻と、2回目に押した時刻を取る
// 読み上げソフトの閲覧のモードでは、ボタンを押すと click だけが届き、キーの押し下げと離しは届かない。
// その click（detail = 0 で、直前にこの部品がキーを扱っていない物）は、hold の道でも 2回押しとして受ける。
//
// 時刻は event.timeStamp で取る。処理が走るまでの遅れ（メインスレッドの混み具合）は差に入らない。
// event.timeStamp が performance.now() と同じ物差しに乗っていないときだけ、処理の時刻に切り替える。
//
// 押している間（2回押しの間）に画面を離れた・窓から離れた・指が外れた・60 秒を超えた場合は「無効票」。

import { estimateReportInterval, isUsableStamp } from './measure.js';

const KEY_CODES = new Set(['Space', 'Enter', 'NumpadEnter']);
const POINTER_TYPES = ['mouse', 'pen', 'touch'];

export const VOID_REASONS = Object.freeze({
  hidden: '押している間に画面を離れた',
  blur: '押している間に窓を離れた',
  'focus-lost': '押している間にボタンから離れた',
  pointercancel: '押している間に指が外れた（ブラウザが操作を引き取った）',
  'capture-lost': '押している間に指が外れた',
  'too-long': '受け付ける長さ（60 秒）を超えた',
  cancelled: '取り消した',
});

function keyName(e) {
  if (e.code && KEY_CODES.has(e.code)) return e.code === 'NumpadEnter' ? 'Enter' : e.code;
  if (e.key === ' ' || e.key === 'Spacebar') return 'Space';
  if (e.key === 'Enter') return 'Enter';
  return null;
}

/**
 * @param {HTMLElement} element 本物の button 要素
 * @param {object} options
 *   mode: 'hold' | 'twice'
 *   onPress(info), onRelease(result), onVoid(result), onState(state)
 *   win, doc, now, setTimer, clearTimer: 試験で差し替える
 * @returns {{ detach(): void, state(): string, cancel(reason?): void, setMode(mode): void }}
 */
export function attachHold(element, options = {}) {
  const g = globalThis;
  const {
    onPress, onRelease, onVoid, onState,
    maxMs = 60000,
    win = g.window ?? null,
    doc = g.document ?? null,
    now = () => g.performance.now(),
    setTimer = (fn, ms) => g.setTimeout(fn, ms),
    clearTimer = (id) => g.clearTimeout(id),
    applyBehaviourStyles = true,
  } = options;
  let mode = options.mode === 'twice' ? 'twice' : 'hold';

  let active = null;           // 受け取りの途中の記録
  let timer = null;
  let lastKeyHandledAt = -Infinity;
  const reports = { mouse: [], pen: [], touch: [] };  // 位置の報告の時刻（照会の周期の実測用）

  // 押し続けに要る振る舞いの指定（見た目ではない）。長押しのメニュー・文字の選択・スクロールへの横取りを止める。
  if (applyBehaviourStyles && element.style) {
    const set = (prop, value) => { try { element.style.setProperty(prop, value); } catch { /* 何もしない */ } };
    set('touch-action', 'none');
    set('user-select', 'none');
    set('-webkit-user-select', 'none');
    set('-webkit-touch-callout', 'none');
  }

  const stampOf = (e) => {
    const handlerAt = now();
    const ts = e.timeStamp;
    const usable = isUsableStamp(ts, handlerAt);
    return { eventTs: usable ? ts : null, handlerAt, delay: usable ? handlerAt - ts : null };
  };

  const stateName = () => (active ? (active.kind === 'mark' ? 'waiting-second' : 'holding') : 'idle');
  const emitState = () => onState?.(stateName());

  const reportFor = (input) => (POINTER_TYPES.includes(input) ? estimateReportInterval(reports[input]) : null);

  function start(info, e) {
    active = { ...info, press: stampOf(e) };
    timer = setTimer(() => voidActive('too-long'), maxMs);
    onPress?.({ mode: active.kind === 'mark' ? 'twice' : 'hold', input: active.input, key: active.key ?? null });
    emitState();
  }

  function clearActive() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (active?.kind === 'pointer') {
      try { element.releasePointerCapture?.(active.pointerId); } catch { /* 何もしない */ }
    }
    active = null;
  }

  function finish(e, releaseInput) {
    const press = active.press;
    const release = stampOf(e);
    const useEvent = press.eventTs !== null && release.eventTs !== null;
    const p = useEvent ? press.eventTs : press.handlerAt;
    const r = useEvent ? release.eventTs : release.handlerAt;
    const inputs = { press: active.input, release: releaseInput ?? active.input };
    const result = {
      ok: true,
      status: 'measured',
      mode: active.kind === 'mark' ? 'twice' : 'hold',
      input: inputs,
      key: active.key ?? null,
      pressStamp: p,
      releaseStamp: r,
      durationMs: r - p,
      stampSource: useEvent ? 'event.timeStamp' : 'handler',
      handlerDelayMs: [press.delay, release.delay],
      pointerReport: { press: reportFor(inputs.press), release: reportFor(inputs.release) },
    };
    clearActive();
    onRelease?.(result);
    emitState();
    return result;
  }

  function voidActive(reason) {
    if (!active) return null;
    const result = {
      ok: false,
      status: 'void',
      label: '無効票',
      reason,
      reasonText: VOID_REASONS[reason] ?? reason,
      mode: active.kind === 'mark' ? 'twice' : 'hold',
      input: { press: active.input, release: null },
    };
    clearActive();
    onVoid?.(result);
    emitState();
    return result;
  }

  // 2回押しの1回分
  function mark(e, input, extra = {}) {
    if (!active) return start({ kind: 'mark', input, ...extra }, e);
    if (active.kind === 'mark') return finish(e, input);
    return null; // 押し続けの途中に来た click などは無視する
  }

  const handlers = {
    keydown(e) {
      const k = keyName(e);
      if (!k || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      e.preventDefault?.();           // スクロールと、ボタンの click への変換を止める
      lastKeyHandledAt = now();
      if (e.repeat) return;           // 押しっぱなしの自動の繰り返しは無視
      if (mode === 'twice') return mark(e, 'keyboard', { key: k });
      if (!active) start({ kind: 'key', input: 'keyboard', key: k }, e);
    },
    keyup(e) {
      const k = keyName(e);
      if (!k) return;
      e.preventDefault?.();
      lastKeyHandledAt = now();
      if (active?.kind === 'key' && active.key === k) finish(e, 'keyboard');
    },
    pointerdown(e) {
      const type = POINTER_TYPES.includes(e.pointerType) ? e.pointerType : 'mouse';
      reports[type].push(e.timeStamp);
      if (type === 'mouse' && e.button !== 0) return;
      if (e.isPrimary === false) return;
      if (mode === 'twice') return mark(e, type);
      if (active) return;
      try { element.setPointerCapture?.(e.pointerId); } catch { /* 何もしない */ }
      start({ kind: 'pointer', input: type, pointerId: e.pointerId }, e);
    },
    pointerup(e) {
      if (active?.kind === 'pointer' && e.pointerId === active.pointerId) finish(e, active.input);
    },
    pointercancel(e) {
      if (active?.kind === 'pointer' && e.pointerId === active.pointerId) voidActive('pointercancel');
    },
    lostpointercapture(e) {
      if (active?.kind === 'pointer' && e.pointerId === active.pointerId) voidActive('capture-lost');
    },
    pointermove(e) {
      const type = POINTER_TYPES.includes(e.pointerType) ? e.pointerType : null;
      if (!type) return;
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const stamps = list.length ? list.map((c) => c.timeStamp) : [e.timeStamp];
      const buf = reports[type];
      buf.push(...stamps);
      if (buf.length > 256) buf.splice(0, buf.length - 256);
    },
    contextmenu(e) { e.preventDefault?.(); },
    selectstart(e) { e.preventDefault?.(); },
    click(e) {
      if (e.detail !== 0) return;                       // マウスや指の click は pointer で扱い済み
      if (now() - lastKeyHandledAt < 300) return;       // キーで扱った押し下げの残り
      mark(e, 'activation');
    },
    blur() {
      if (active?.kind === 'key') voidActive('focus-lost');
    },
  };
  const winHandlers = {
    blur() { voidActive('blur'); },
    pagehide() { voidActive('hidden'); },
  };
  const docHandlers = {
    visibilitychange() { if (doc?.visibilityState === 'hidden') voidActive('hidden'); },
  };

  for (const [type, fn] of Object.entries(handlers)) element.addEventListener(type, fn);
  for (const [type, fn] of Object.entries(winHandlers)) win?.addEventListener(type, fn);
  for (const [type, fn] of Object.entries(docHandlers)) doc?.addEventListener(type, fn);

  return {
    detach() {
      clearActive();
      for (const [type, fn] of Object.entries(handlers)) element.removeEventListener(type, fn);
      for (const [type, fn] of Object.entries(winHandlers)) win?.removeEventListener(type, fn);
      for (const [type, fn] of Object.entries(docHandlers)) doc?.removeEventListener(type, fn);
    },
    state: stateName,
    cancel: (reason = 'cancelled') => voidActive(reason),
    setMode(next) {
      if (next !== 'hold' && next !== 'twice') throw new RangeError('mode は hold か twice');
      voidActive('cancelled');
      mode = next;
    },
    get mode() { return mode; },
  };
}
