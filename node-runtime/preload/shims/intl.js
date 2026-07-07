'use strict';
// Minimal Intl polyfill for nodejs-mobile stock (--with-intl=none, no Intl object).
// Goal: prevent ReferenceError/TypeError on the Intl.* call sites in cli.js.
//
// The constructors are dual-callable (with OR without `new`) to match real Intl —
// e.g. `Intl.DateTimeFormat(...)` as a plain call must work, which an ES6 class
// cannot do. Fidelity is deliberately basic (English/ASCII-ish); the fallback if a
// real code path needs more is a full-icu Node build.

function install() {
  if (typeof globalThis.Intl !== 'undefined' && globalThis.Intl && !globalThis.Intl.__polyfill) {
    if (needsSegmenterShim()) installSegmenter(globalThis.Intl);
    return;
  }

  const Intl = {};

  // Intl.DateTimeFormat — format/formatToParts backed by Date's own methods.
  function DateTimeFormat(locales, options) {
    if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locales, options);
    this._opts = options || {}; this._locale = normLocale(locales);
  }
  DateTimeFormat.prototype.format = function (d) { const date = d == null ? new Date() : (d instanceof Date ? d : new Date(d)); return date.toString(); };
  DateTimeFormat.prototype.formatToParts = function (d) { return [{ type: 'literal', value: this.format(d) }]; };
  DateTimeFormat.prototype.formatRange = function (a, b) { return `${this.format(a)} – ${this.format(b)}`; };
  DateTimeFormat.prototype.resolvedOptions = function () { return { locale: this._locale, timeZone: this._opts.timeZone || 'UTC', calendar: 'gregory', numberingSystem: 'latn', ...this._opts }; };
  Intl.DateTimeFormat = DateTimeFormat;

  // Intl.NumberFormat — grouping + basic fraction digits.
  function NumberFormat(locales, options) {
    if (!(this instanceof NumberFormat)) return new NumberFormat(locales, options);
    this._opts = options || {}; this._locale = normLocale(locales);
  }
  NumberFormat.prototype.format = function (n) {
    const num = Number(n);
    if (!isFinite(num)) return String(num);
    const o = this._opts;
    let s;
    if (o.minimumFractionDigits != null || o.maximumFractionDigits != null) {
      const max = o.maximumFractionDigits != null ? o.maximumFractionDigits : Math.max(o.minimumFractionDigits || 0, 3);
      s = num.toFixed(Math.min(max, 20));
      // Only trim zeros in the fraction part — a bare /\.?0+$/ would eat integer
      // zeros too (e.g. maximumFractionDigits:0 turned 1000 into "1").
      if (o.minimumFractionDigits == null && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    } else { s = String(num); }
    if (o.useGrouping !== false) {
      const neg = s.startsWith('-'); if (neg) s = s.slice(1);
      const [int, frac] = s.split('.');
      const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      s = (neg ? '-' : '') + (frac ? `${g}.${frac}` : g);
    }
    if (o.style === 'percent') s = `${s}%`;
    return s;
  };
  NumberFormat.prototype.formatToParts = function (n) { return [{ type: 'literal', value: this.format(n) }]; };
  NumberFormat.prototype.resolvedOptions = function () { return { locale: this._locale, numberingSystem: 'latn', ...this._opts }; };
  Intl.NumberFormat = NumberFormat;

  // Intl.RelativeTimeFormat
  function RelativeTimeFormat(locales, options) {
    if (!(this instanceof RelativeTimeFormat)) return new RelativeTimeFormat(locales, options);
    this._opts = options || {}; this._locale = normLocale(locales);
  }
  RelativeTimeFormat.prototype.format = function (value, unit) {
    const v = Number(value); const u = String(unit).replace(/s$/, '');
    if (v === 0) return `this ${u}`;
    const abs = Math.abs(v); const plural = abs === 1 ? u : u + 's';
    return v < 0 ? `${abs} ${plural} ago` : `in ${abs} ${plural}`;
  };
  RelativeTimeFormat.prototype.formatToParts = function (v, u) { return [{ type: 'literal', value: this.format(v, u) }]; };
  RelativeTimeFormat.prototype.resolvedOptions = function () { return { locale: this._locale, ...this._opts }; };
  Intl.RelativeTimeFormat = RelativeTimeFormat;

  // Intl.Segmenter — grapheme/word/sentence segmentation (grapheme-cluster approximation;
  // cli.js/Ink use grapheme granularity for terminal width math on every render).
  installSegmenter(Intl);

  // Intl.Locale
  function Locale(tag) {
    if (!(this instanceof Locale)) return new Locale(tag);
    const t = String(tag || 'en'); this.baseName = t;
    const parts = t.split('-');
    this.language = parts[0] || 'en';
    this.region = parts.find((p) => /^[A-Z]{2}$/.test(p));
    this.script = parts.find((p) => /^[A-Z][a-z]{3}$/.test(p));
  }
  Locale.prototype.toString = function () { return this.baseName; };
  Locale.prototype.maximize = function () { return this; };
  Locale.prototype.minimize = function () { return this; };
  Intl.Locale = Locale;

  // Intl.Collator — needed for locale-aware sort; approximate with default compare.
  function Collator(locales, options) {
    if (!(this instanceof Collator)) return new Collator(locales, options);
    this._opts = options || {}; this._locale = normLocale(locales);
  }
  Collator.prototype.compare = function (a, b) {
    const x = String(a), y = String(b);
    if (this._opts && this._opts.numeric) return x.localeCompare(y, undefined, { numeric: true });
    return x < y ? -1 : x > y ? 1 : 0;
  };
  Collator.prototype.resolvedOptions = function () { return { locale: this._locale, ...this._opts }; };
  Intl.Collator = Collator;

  // Intl.PluralRules
  function PluralRules(locales, options) {
    if (!(this instanceof PluralRules)) return new PluralRules(locales, options);
    this._opts = options || {}; this._locale = normLocale(locales);
  }
  PluralRules.prototype.select = function (n) { return Number(n) === 1 ? 'one' : 'other'; };
  PluralRules.prototype.resolvedOptions = function () { return { locale: this._locale, ...this._opts }; };
  Intl.PluralRules = PluralRules;

  Intl.getCanonicalLocales = (l) => (Array.isArray(l) ? l.map(String) : [String(l || 'en')]);
  Intl.supportedValuesOf = () => [];
  Intl.__polyfill = true;

  globalThis.Intl = Intl;
}

function needsSegmenterShim() {
  return process.env.CLAUDE_IOS_TTY === '1' ||
    process.env.CLAUDE_IOS_SESSION === '1' ||
    process.platform === 'ios';
}

function installSegmenter(targetIntl) {
  try {
    Object.defineProperty(targetIntl, 'Segmenter', {
      configurable: true,
      writable: true,
      value: Segmenter,
    });
    targetIntl.__iosSegmenterPolyfill = true;
  } catch {
    try { targetIntl.Segmenter = Segmenter; targetIntl.__iosSegmenterPolyfill = true; } catch {}
  }
}

function Segmenter(locales, options) {
  if (!(this instanceof Segmenter)) return new Segmenter(locales, options);
  this._granularity = (options && options.granularity) || 'grapheme'; this._locale = normLocale(locales);
}
Segmenter.prototype.segment = function (str) {
  const input = String(str); const granularity = this._granularity;
  return { [Symbol.iterator]() {
    if (granularity === 'word') return wordIter(input);
    if (granularity === 'sentence') return sentenceIter(input);
    return graphemeIter(input);
  } };
};
Segmenter.prototype.resolvedOptions = function () { return { locale: this._locale, granularity: this._granularity }; };

function normLocale(locales) {
  if (!locales) return 'en-US';
  if (Array.isArray(locales)) return String(locales[0] || 'en-US');
  return String(locales);
}

// Grapheme-cluster approximation, precompiled once. \p{} property escapes run in
// V8's irregexp interpreter — jitless-safe, no WASM. Alternatives, in order:
//   \r\n                 CRLF is one cluster
//   \p{RI}\p{RI}         flag emoji (regional-indicator pairs)
//   \P{M}(\p{M}|\p{EMod})* base + combining marks (VS15/16 + keycap U+20E3 are gc=M)
//                          + skin-tone modifiers (gc=Sk, so matched via EMod)
//     (\u200D ...)*      ZWJ chains (family/profession emoji), each link same shape
//   [\s\S]               anything left (lone marks/surrogates) — guarantees progress
// Deliberately not full UAX#29 (no GB9c/prepend/jamo runs); covers real-world TUI text.
const GRAPHEME_RE = (() => {
  // nodejs-mobile V8 lacks a Unicode property DB: regex \\p{RI}/\\p{M}/\\p{EMod}
  // throw "Invalid property name" at COMPILE time and crash the runtime at load.
  // Build from explicit code-point RANGES; try/catch degrades to a code-point split.
  try {
    const MARK = "[\\u0300-\\u036F\\u0483-\\u0489\\u0591-\\u05BD\\u05BF\\u0610-\\u061A" +
      "\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u0711\\u0730-\\u074A" +
      "\\u0E31\\u0E34-\\u0E3A\\u0EB1\\u0EB4-\\u0EBC\\u0F71-\\u0F84\\u1AB0-\\u1AFF" +
      "\\u1DC0-\\u1DFF\\u20D0-\\u20F0\\uFE00-\\uFE0F\\uFE20-\\uFE2F\\u{1F3FB}-\\u{1F3FF}]";
    const RI = "[\\u{1F1E6}-\\u{1F1FF}]";
    const B = "[\\s\\S]";
    return new RegExp("\\r\\n|" + RI + RI + "|" + B + MARK + "*(?:\\u200D" + B + MARK + "*)*|" + B, "gu");
  } catch { return null; }
})();

function* graphemeIter(input) {
  if (GRAPHEME_RE) {
    for (const m of input.matchAll(GRAPHEME_RE)) yield { segment: m[0], index: m.index, input };
    return;
  }
  let i = 0;
  for (const ch of input) { yield { segment: ch, index: i, input }; i += ch.length; }
}
function* wordIter(input) {
  const re = /(\s+|[^\s]+)/g; let m;
  while ((m = re.exec(input))) { yield { segment: m[0], index: m.index, input, isWordLike: !/^\s+$/.test(m[0]) }; }
}
function* sentenceIter(input) {
  const re = /[^.!?]*[.!?]+|\s*[^.!?]+$/g; let m;
  while ((m = re.exec(input))) { if (m[0]) yield { segment: m[0], index: m.index, input }; }
}

module.exports = { install };
