// 組み立ての道具（tools/build.mjs）が作った物。手で直さず、元を直して作り直す。
// 言葉を目標の明るさにする（ブラウザ用。OffscreenCanvas か canvas の 2D）。
// 書体は端末の sans-serif の太字。白い字を黒地に細かい画素で描き、平均して n×n に縮め、
// 字を少しぼかし、地に明るさを少し残す。値は全部引数で変えられる。

export const TARGET_DEFAULTS = Object.freeze({
  floor: 0.12, // 地に残す明るさ（字の明るさが 1）
  blur: 0.0045, // ぼかしの標準偏差（正方形の一辺に対する割合）
  margin: 0.07, // 正方形の縁に空ける幅（一辺に対する割合）
  lineGap: 1.12, // 2行のときの行の送り（字の大きさに対する割合）
  supersample: 4,
  family: 'sans-serif',
  weight: '700',
});

function makeCanvas(S) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(S, S);
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  return c;
}

// 英字どうし、数字どうしの間では行を割らない（単語や数の途中で割らない）。
// 英字は全角も含むラテン文字と、ギリシャ文字・キリル文字。数字は全角も含む10進の数字
const LETTER = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]$/u;
const DIGIT = /^\p{Nd}$/u;
function kind(ch) {
  if (DIGIT.test(ch)) return 'digit';
  if (LETTER.test(ch) && /^\p{L}$/u.test(ch)) return 'letter';
  return 'other';
}

function canBreak(a, b) {
  const ka = kind(a);
  return !(ka !== 'other' && ka === kind(b));
}

// 字の幅。半角を 0.5、全角を 1 と数える。半角は U+0000〜U+04FF（ラテン文字・ギリシャ文字・キリル文字と記号）、
// 半角のカタカナと記号（U+FF61〜U+FFDC、U+FFE8〜U+FFEE）。ほかは全角
export function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c <= 0x04ff || (c >= 0xff61 && c <= 0xffdc) || (c >= 0xffe8 && c <= 0xffee)) return 0.5;
  return 1;
}

export function wordWidth(word) {
  let w = 0;
  for (const ch of Array.from(String(word))) w += charWidth(ch);
  return w;
}

/**
 * 行の割り方。幅（全角 1、半角 0.5）が 3 までは1行。
 * それより長いときは、2行の幅の差がいちばん小さい切れ目で割り、差が同じなら1行目を長くする（4 は 2 と 2、5 は 3 と 2、6 は 3 と 3）。
 * 割ってよい切れ目は、英字どうし・数字どうしの間でなく、どちらの行も2字以上になる所。
 * 割ってよい切れ目が無いとき、またはいちばん近い切れ目でも2行の幅の差が全角1字を超えるときは1行にする。
 * 切れ目の空白は行の端に残さない
 * @param {string} word
 * @returns {string[]} 1つか2つの行
 */
export function splitLines(word) {
  const chars = Array.from(String(word).trim());
  const one = [chars.join('')];
  if (wordWidth(one[0]) <= 3) return one;
  let best = null;
  for (let k = 1; k < chars.length; k++) {
    if (!canBreak(chars[k - 1], chars[k])) continue;
    const a = chars.slice(0, k).join('').trimEnd();
    const b = chars.slice(k).join('').trimStart();
    const ca = Array.from(a.replace(/\s/gu, '')).length;
    const cb = Array.from(b.replace(/\s/gu, '')).length;
    if (ca < 2 || cb < 2) continue;
    const d = wordWidth(a) - wordWidth(b);
    const score = Math.abs(d);
    if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && d > best.d)) best = { lines: [a, b], score, d };
  }
  if (!best || best.score > 1 + 1e-9) return one;
  return best.lines;
}

// 行ごとの字の外形を測る（字の大きさ F0 のとき）
function measureLines(ctx, lines) {
  return lines.map((s) => {
    const m = ctx.measureText(s);
    return {
      text: s,
      left: m.actualBoundingBoxLeft,
      right: m.actualBoundingBoxRight,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
    };
  });
}

function layoutScale(ms, F0, gap, box) {
  let width = 0;
  for (const m of ms) width = Math.max(width, m.left + m.right);
  const top = -ms[0].ascent;
  const bottom = (ms.length - 1) * F0 * gap + ms[ms.length - 1].descent;
  const height = bottom - top;
  return Math.min(box / Math.max(width, 1e-6), box / Math.max(height, 1e-6));
}

function gaussianBlur(src, n, sigma) {
  if (!(sigma > 0.05)) return src;
  const rad = Math.ceil(3 * sigma);
  const k = new Float64Array(2 * rad + 1);
  let ks = 0;
  for (let i = -rad; i <= rad; i++) {
    k[i + rad] = Math.exp((-i * i) / (2 * sigma * sigma));
    ks += k[i + rad];
  }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float64Array(n * n);
  const out = new Float64Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        let cc = c + i;
        if (cc < 0) cc = -cc - 1;
        else if (cc >= n) cc = 2 * n - cc - 1;
        s += k[i + rad] * src[r * n + cc];
      }
      tmp[r * n + c] = s;
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        let rr = r + i;
        if (rr < 0) rr = -rr - 1;
        else if (rr >= n) rr = 2 * n - rr - 1;
        s += k[i + rad] * tmp[rr * n + c];
      }
      out[r * n + c] = s;
    }
  }
  return out;
}

/**
 * @param {string} word 言葉（6字まで）
 * @param {number} n 目標のマスの数
 * @param {object} options TARGET_DEFAULTS を上書きする
 * @returns {{data: Float32Array, mean: number, fontPx: number, lines: string[]}}
 *   data: n×n、行ごと、上の行から。地は floor、字は 1
 */
export function makeTarget(word, n, options = {}) {
  const o = { ...TARGET_DEFAULTS, ...options };
  const chars = Array.from(String(word).trim());
  if (chars.length === 0) throw new Error('言葉が空');
  const S = n * o.supersample;
  const canvas = makeCanvas(S);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if ('lang' in ctx) ctx.lang = 'ja';
  const F0 = 100;
  const font = (F) => `${o.weight} ${F}px ${o.family}`;
  ctx.font = font(F0);
  const box = S * (1 - 2 * o.margin);

  // 行の割り方は splitLines。字の大きさは、正方形の縁を空けた枠にいちばん大きく入る大きさ
  const lines = splitLines(chars.join(''));
  const best = { lines, scale: layoutScale(measureLines(ctx, lines), F0, o.lineGap, box) };
  const F = F0 * best.scale;
  ctx.font = font(F);
  const ms = measureLines(ctx, best.lines);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const pitch = F * o.lineGap;
  const top = -ms[0].ascent;
  const bottom = (ms.length - 1) * pitch + ms[ms.length - 1].descent;
  const y0 = S / 2 - (top + bottom) / 2;
  ms.forEach((m, i) => {
    const x = S / 2 - (m.right - m.left) / 2;
    ctx.fillText(m.text, x, y0 + i * pitch);
  });

  const img = ctx.getImageData(0, 0, S, S).data;
  const cov = new Float64Array(n * n);
  const f = o.supersample;
  const w = 1 / (255 * f * f);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let s = 0;
      for (let b = 0; b < f; b++) {
        const row = ((r * f + b) * S + c * f) * 4;
        for (let a = 0; a < f; a++) s += img[row + a * 4];
      }
      cov[r * n + c] = s * w;
    }
  }
  const blurred = gaussianBlur(cov, n, o.blur * n);
  const data = new Float32Array(n * n);
  let sum = 0;
  for (let i = 0; i < n * n; i++) {
    const v = Math.min(1, Math.max(0, blurred[i]));
    data[i] = o.floor + (1 - o.floor) * v;
    sum += data[i];
  }
  return { data, mean: sum / (n * n), fontPx: (F / S) * n, lines: best.lines };
}
