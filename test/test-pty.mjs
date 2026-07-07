// Phase 1 core: userspace termios line discipline (preload/pty.js).
// Verifies cooked/raw modes, echo, line editing, control-char->signal, EOF,
// OPOST output mapping, and resize — the tty semantics iOS won't give us.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LineDiscipline } = require('../node-runtime/preload/pty.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

// Build a discipline that records what goes to program / terminal / signals.
function mk(opts = {}) {
  const toProg = [], toTerm = [], sigs = []; let eofs = 0;
  const ld = new LineDiscipline({
    toProgram: (b) => toProg.push(b.toString('latin1')),
    toTerminal: (b) => toTerm.push(b.toString('latin1')),
    onSignal: (s) => sigs.push(s),
    onEof: () => { eofs++; },
    ...opts,
  });
  return { ld, prog: () => toProg.join(''), term: () => toTerm.join(''), sigs, eofs: () => eofs };
}

console.log('=== userspace PTY line discipline (Node ' + process.version + ') ===');

// 1) COOKED: line buffered, delivered only on Enter, with echo.
{
  const t = mk();
  t.ld.inputFromTerminal('hello');
  ok(t.prog() === '', 'cooked: nothing delivered before Enter (line buffered)');
  ok(t.term() === 'hello', 'cooked: keystrokes echoed as typed');
  t.ld.inputFromTerminal('\r');
  ok(t.prog() === 'hello\n', 'cooked: Enter delivers the whole line with \\n (CR->NL)');
  ok(t.term().endsWith('\r\n'), 'cooked: Enter echoes CR-LF');
}

// 2) Backspace (VERASE) edits the buffer + erases on screen.
{
  const t = mk();
  t.ld.inputFromTerminal('abc');
  t.ld.inputFromTerminal(Buffer.from([0x7f]));  // Backspace
  t.ld.inputFromTerminal('X\r');
  ok(t.prog() === 'abX\n', 'VERASE: backspace removed last char before delivery');
  ok(t.term().includes('\b \b'), 'VERASE: erased on screen with "\\b \\b"');
}

// 3) Kill-line (VKILL, ^U) clears the pending line.
{
  const t = mk();
  t.ld.inputFromTerminal('garbage');
  t.ld.inputFromTerminal(Buffer.from([0x15]));  // ^U
  t.ld.inputFromTerminal('clean\r');
  ok(t.prog() === 'clean\n', 'VKILL: ^U cleared the line buffer');
}

// 4) Word-erase (VWERASE, ^W).
{
  const t = mk();
  t.ld.inputFromTerminal('foo bar baz');
  t.ld.inputFromTerminal(Buffer.from([0x17]));  // ^W
  t.ld.inputFromTerminal('\r');
  ok(t.prog() === 'foo bar \n', 'VWERASE: ^W erased the last word');
}

// 5) ISIG: ^C -> SIGINT, flushes the line, not passed to program.
{
  const t = mk();
  t.ld.inputFromTerminal('partial');
  t.ld.inputFromTerminal(Buffer.from([0x03]));  // ^C
  t.ld.inputFromTerminal('after\r');
  ok(t.sigs.includes('SIGINT'), 'ISIG: ^C raised SIGINT');
  ok(t.prog() === 'after\n', 'ISIG: ^C flushed the pending line (partial not delivered)');
  ok(t.term().includes('^C'), 'ISIG: ^C echoed as ^C');
}

// 6) ^Z -> SIGTSTP, ^\ -> SIGQUIT.
{
  const t = mk();
  t.ld.inputFromTerminal(Buffer.from([0x1a]));  // ^Z
  t.ld.inputFromTerminal(Buffer.from([0x1c]));  // ^\
  ok(t.sigs.includes('SIGTSTP'), 'ISIG: ^Z raised SIGTSTP');
  ok(t.sigs.includes('SIGQUIT'), 'ISIG: ^\\ raised SIGQUIT');
}

// 7) EOF: ^D on empty line -> onEof; ^D on non-empty -> deliver line (no NL).
{
  const t = mk();
  t.ld.inputFromTerminal('data');
  t.ld.inputFromTerminal(Buffer.from([0x04]));  // ^D with pending line
  ok(t.prog() === 'data', 'VEOF: ^D on non-empty line delivered it immediately (no newline)');
  t.ld.inputFromTerminal(Buffer.from([0x04]));  // ^D on empty line
  ok(t.eofs() === 1, 'VEOF: ^D on empty line signalled EOF');
}

// 8) ECHO off: keystrokes buffered but not shown (password style).
{
  const t = mk();
  t.ld.setEcho(false);
  t.ld.inputFromTerminal('secret\r');
  ok(t.prog() === 'secret\n', 'ECHO off: line still delivered');
  ok(t.term() === '\r\n', 'ECHO off: characters NOT echoed (only the newline)');
}

// 9) RAW mode: bytes pass straight through, no echo, no line buffering.
{
  const t = mk();
  t.ld.setRaw(true);
  t.ld.inputFromTerminal('abc');
  ok(t.prog() === 'abc', 'raw: bytes delivered immediately, unbuffered');
  ok(t.term() === '', 'raw: no echo (the program decides what to render)');
  // arrow key escape sequence passes through intact
  t.ld.inputFromTerminal(Buffer.from([0x1b, 0x5b, 0x41])); // ESC [ A  (Up)
  ok(t.prog() === 'abc\x1b[A', 'raw: escape sequences (arrow keys) pass through intact');
}

// 10) RAW with ISIG off: ^C is a literal byte to the program (vim needs this).
{
  const t = mk();
  t.ld.setRaw(true);  // clears ISIG
  t.ld.inputFromTerminal(Buffer.from([0x03]));
  ok(t.prog() === '\x03' && t.sigs.length === 0, 'raw+ISIG off: ^C delivered as a literal byte, no signal');
}

// 11) OPOST/ONLCR: program \n becomes \r\n on the terminal.
{
  const t = mk();
  t.ld.outputFromProgram('line1\nline2\n');
  ok(t.term() === 'line1\r\nline2\r\n', 'OPOST/ONLCR: program \\n mapped to \\r\\n for the terminal');
  const t2 = mk();
  t2.ld.outputFromProgram('already\r\ncrlf\r\n');
  ok(t2.term() === 'already\r\ncrlf\r\n', 'OPOST/ONLCR: existing \\r\\n left intact (no double \\r)');
}

// 12) resize -> SIGWINCH + new dimensions.
{
  const t = mk();
  t.ld.resize(120, 40);
  ok(t.sigs.includes('SIGWINCH') && t.ld.cols === 120 && t.ld.rows === 40, 'resize: updated winsize + raised SIGWINCH');
}

// 13) multi-byte UTF-8 keystroke buffered/delivered whole (Chinese input).
{
  const t = mk();
  t.ld.inputFromTerminal(Buffer.from('中文', 'utf8'));
  t.ld.inputFromTerminal('\r');
  ok(Buffer.from(t.prog(), 'latin1').equals(Buffer.concat([Buffer.from('中文', 'utf8'), Buffer.from('\n')])),
     'UTF-8: multi-byte characters buffered and delivered intact');
}

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
