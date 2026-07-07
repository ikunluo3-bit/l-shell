// Regression tests for the Intl polyfill fixes (audit P1 #11):
//   - Segmenter grapheme granularity clusters ZWJ emoji / flags / skin tones /
//     keycaps / combining marks / CRLF (was per-code-point → TUI width drift)
//   - NumberFormat maximumFractionDigits:0 no longer strips integer zeros
// Run under: node --jitless test/test-intl-fixes.mjs   (works on Node 18 and Node 24)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

// Force OUR polyfill: strip native Intl exactly like test/ios-sim-preload.js does,
// so these assertions exercise the shim, not V8's ICU.
try { delete globalThis.Intl; } catch {}
if (typeof globalThis.Intl !== 'undefined') { console.error('FATAL: Intl strip failed'); process.exit(1); }
require('../node-runtime/preload/shims/intl.js').install();
if (!globalThis.Intl || !globalThis.Intl.__polyfill) { console.error('FATAL: polyfill not active'); process.exit(1); }
console.log('Intl polyfill forced (native stripped) | WebAssembly:', typeof globalThis.WebAssembly);

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // 👨\u200D👩\u200D👧
const FLAGS = '\u{1F1E8}\u{1F1F3}\u{1F1FA}\u{1F1F8}';     // 🇨🇳🇺🇸
const THUMB = '\u{1F44D}\u{1F3FD}';                       // 👍🏽 (skin tone)
const KEYCAP = '1\uFE0F\u20E3';                           // 1️⃣
const ACCENT = 'e\u0301';                                 // e + combining acute

const seg = (s, opts) => [...new Intl.Segmenter('en', opts || { granularity: 'grapheme' }).segment(s)];
const count = (s) => seg(s).length;

// --- grapheme cluster counts ---
ok(count(FAMILY) === 1, 'ZWJ family emoji = 1 segment');
ok(count(FLAGS) === 2, 'two RI flags = 2 segments');
ok(count(THUMB) === 1, 'thumbs-up + skin-tone modifier = 1 segment');
ok(count(ACCENT) === 1, 'e + combining acute = 1 segment');
ok(count(KEYCAP) === 1, 'keycap sequence (1 + VS16 + U+20E3) = 1 segment');
ok(count('a' + FAMILY + 'b') === 3, 'ascii + family + ascii = 3 segments');
ok(count('中文') === 2, 'CJK = 2 segments');
ok(count('\r\n') === 1, 'CRLF = 1 segment');
ok(count('hello') === 5, 'plain ASCII unchanged (5 segments)');
ok(seg('hello').map((p) => p.segment).join('') === 'hello', 'ASCII segments round-trip');
ok(count('\u2764\uFE0F') === 1, 'heart + VS16 = 1 segment');
ok(count('\u{1F469}\u{1F3FD}\u200D\u{1F4BB}') === 1, 'skin tone inside ZWJ chain = 1 segment');
ok(count('') === 0, 'empty string = 0 segments');

// --- segment.index / input correctness on a mixed string ---
const mixed = 'a' + FAMILY + 'b' + FLAGS.slice(0, 4) + ACCENT + '!';
const parts = seg(mixed);
let off = 0, contiguous = true, inputOk = true;
for (const p of parts) {
  if (p.index !== off) contiguous = false;
  if (p.input !== mixed) inputOk = false;
  off += p.segment.length;
}
ok(contiguous && off === mixed.length, 'segment.index contiguous, covers full string');
ok(inputOk, 'segment.input is the original string');
ok(parts.map((p) => p.segment).join('') === mixed, 'mixed string round-trips');
ok(parts.length === 6, 'mixed string = 6 segments (a, family, b, flag, e-acute, !)');
ok(parts[1].segment === FAMILY && parts[1].index === 1, 'family segment text + index correct');
ok(parts[3].index === 10, 'flag segment index accounts for surrogate pairs');

// --- dual-callable (hard-won: must work with AND without new) ---
const noNew = Intl.Segmenter('en', { granularity: 'grapheme' });
ok(noNew instanceof Intl.Segmenter, 'Intl.Segmenter() callable without new');
ok([...noNew.segment(THUMB)].length === 1, 'no-new instance clusters graphemes');
ok([...new Intl.Segmenter().segment(FAMILY)].length === 1, 'default granularity is grapheme');

// --- Segments object re-iterable ---
const segs = new Intl.Segmenter().segment(FLAGS);
ok([...segs].length === 2 && [...segs].length === 2, 'segment() result iterable more than once');

// --- word / sentence granularity keep existing behavior ---
const words = seg('hi there', { granularity: 'word' });
ok(words.length === 3 && words[0].isWordLike === true && words[1].isWordLike === false, 'word granularity unchanged');
const sents = seg('One. Two.', { granularity: 'sentence' });
ok(sents.length === 2, 'sentence granularity unchanged');

// --- existing shim suite expectation still holds ---
ok([...new Intl.Segmenter().segment('héllo')].length === 5, 'héllo = 5 segments (test-shims parity)');

// --- NumberFormat fraction-trim fix (was: maximumFractionDigits:0 → 1000 → "1") ---
ok(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(1000) === '1,000', 'maxFrac:0 keeps integer zeros');
ok(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(100) === '100', 'maxFrac:0 format(100) = "100"');
ok(new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(1.5) === '1.5', 'trailing fraction zeros still trimmed');
ok(new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(100) === '100', 'integer with fraction opts stays intact');
ok(new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(-1000.5) === '-1,000.5', 'negative grouping + trim');
ok(new Intl.NumberFormat().format(1234567) === '1,234,567', 'grouping unchanged');
ok(new Intl.NumberFormat('en', { minimumFractionDigits: 2 }).format(5).startsWith('5.00'), 'minFractionDigits keeps zeros');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
