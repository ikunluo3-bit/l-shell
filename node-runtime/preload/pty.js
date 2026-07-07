'use strict';
// Userspace termios line discipline — the "kernel tty" iOS won't give us.
// Sits between the terminal emulator (SwiftTerm: raw key bytes in, render bytes
// out) and an in-process program's stdin/stdout. Reimplements the subset of a
// real tty line discipline that full-screen and cooked programs actually need,
// modelled on iSH's fs/tty.c. Pure JS, jitless-safe, per-session instance.
//
// Data flow:
//   terminal keys ──inputFromTerminal()──▶ [echo back to terminal] + program stdin
//   program stdout ──outputFromProgram()──▶ [OPOST \n→\r\n] ──▶ terminal
//
// Callbacks (all receive Buffers except onSignal):
//   toProgram(buf)   bytes delivered to the program's stdin (a whole line in
//                    canonical mode, or raw bytes in raw mode)
//   toTerminal(buf)  bytes to render on the terminal (echo + program output)
//   onSignal(name)   'SIGINT' | 'SIGTSTP' | 'SIGQUIT' | 'SIGWINCH'
//   onEof()          canonical ^D on an empty line (program read() returns 0)

// Default control characters (matches a fresh Unix tty).
const CC = {
  VINTR: 0x03,   // ^C  -> SIGINT
  VQUIT: 0x1c,   // ^\  -> SIGQUIT
  VERASE: 0x7f,  // DEL -> erase char (terminals send 0x7f for Backspace)
  VKILL: 0x15,   // ^U  -> erase line
  VEOF: 0x04,    // ^D  -> end of file
  VSUSP: 0x1a,   // ^Z  -> SIGTSTP
  VWERASE: 0x17, // ^W  -> erase word
  VLNEXT: 0x16,  // ^V  -> literal next
  VREPRINT: 0x12,// ^R  -> reprint line
};

// Local-mode / input / output flags we honor.
const DEFAULT_FLAGS = {
  ICANON: true, ECHO: true, ECHOE: true, ECHOCTL: true, ISIG: true, IEXTEN: true,
  ICRNL: true,  // map CR -> NL on input
  OPOST: true, ONLCR: true,  // map NL -> CR-NL on output
  NOFLSH: false,
};

class LineDiscipline {
  constructor(opts = {}) {
    this.toProgram = opts.toProgram || (() => {});
    this.toTerminal = opts.toTerminal || (() => {});
    this.onSignal = opts.onSignal || (() => {});
    this.onEof = opts.onEof || (() => {});
    this.cc = { ...CC, ...(opts.cc || {}) };
    this.flags = { ...DEFAULT_FLAGS, ...(opts.flags || {}) };
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
    this._line = [];      // pending canonical line (byte values)
    this._lnext = false;  // VLNEXT pending (next byte is literal)
  }

  // ---- mode control (what setRawMode / tcsetattr would do) ----
  setRaw(on) {
    if (on) {
      // cfmakeraw: clear these local/input/output flags.
      Object.assign(this.flags, { ICANON: false, ECHO: false, ISIG: false, ICRNL: false, OPOST: false, IEXTEN: false });
    } else {
      Object.assign(this.flags, DEFAULT_FLAGS);
    }
  }
  setFlag(name, val) { this.flags[name] = !!val; }
  setEcho(on) { this.flags.ECHO = !!on; }

  resize(cols, rows) {
    if (cols > 0) this.cols = cols;
    if (rows > 0) this.rows = rows;
    this.onSignal('SIGWINCH');
  }

  // ---- terminal -> program (keystrokes) ----
  inputFromTerminal(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!this.flags.ICANON) return this._inputRaw(buf);
    for (let i = 0; i < buf.length; i++) this._canonByte(buf[i]);
  }

  _inputRaw(buf) {
    // Raw mode: bytes pass straight through. Signals still fire if ISIG is set
    // (rare in raw, but honor it); no echo, no line editing.
    if (!this.flags.ISIG) { this.toProgram(buf); return; }
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const sig = this._signalFor(buf[i]);
      if (sig) {
        if (i > start) this.toProgram(buf.subarray(start, i));
        this.onSignal(sig);
        start = i + 1;
      }
    }
    if (start < buf.length) this.toProgram(buf.subarray(start));
  }

  _signalFor(b) {
    if (!this.flags.ISIG) return null;
    if (b === this.cc.VINTR) return 'SIGINT';
    if (b === this.cc.VSUSP) return 'SIGTSTP';
    if (b === this.cc.VQUIT) return 'SIGQUIT';
    return null;
  }

  _canonByte(b) {
    if (this._lnext) { this._lnext = false; this._append(b, true); return; }

    // signals first (recognized, not passed as input)
    const sig = this._signalFor(b);
    if (sig) {
      if (!this.flags.NOFLSH) this._line = [];
      if (this.flags.ECHOCTL) this._echo(Buffer.from('^' + String.fromCharCode(b ^ 0x40)));
      this._echo(Buffer.from('\r\n'));
      this.onSignal(sig);
      return;
    }

    if (this.flags.IEXTEN && b === this.cc.VLNEXT) { this._lnext = true; return; }

    if (b === this.cc.VERASE) { this._erase(1); return; }
    if (this.flags.IEXTEN && b === this.cc.VWERASE) { this._eraseWord(); return; }
    if (b === this.cc.VKILL) { this._eraseLine(); return; }

    if (b === this.cc.VEOF) {           // ^D
      if (this._line.length > 0) { this._deliverLine(false); }
      else { this.onEof(); }
      return;
    }

    // CR / LF -> deliver the line
    if (b === 0x0d /* CR */) {
      if (this.flags.ICRNL) b = 0x0a;   // map CR to NL
      this._append(b, false);
      this._echo(Buffer.from('\r\n'));
      this._deliverLine(true);
      return;
    }
    if (b === 0x0a /* LF */) {
      this._append(b, false);
      this._echo(Buffer.from('\r\n'));
      this._deliverLine(true);
      return;
    }

    this._append(b, true);
  }

  _append(b, echo) {
    this._line.push(b);
    if (echo && this.flags.ECHO) {
      if (b < 0x20 && b !== 0x09 && this.flags.ECHOCTL) this._echo(Buffer.from('^' + String.fromCharCode(b ^ 0x40)));
      else this._echo(Buffer.from([b]));
    }
  }

  _erase(n) {
    for (let k = 0; k < n && this._line.length; k++) {
      const removed = this._line.pop();
      if (this.flags.ECHO && this.flags.ECHOE) {
        // control chars were echoed as 2 cols (^X); erase 2, else 1.
        const width = (removed < 0x20 && removed !== 0x09 && this.flags.ECHOCTL) ? 2 : 1;
        this._echo(Buffer.from('\b \b'.repeat(width)));
      }
    }
  }
  _eraseWord() {
    // erase trailing spaces then the word
    while (this._line.length && this._line[this._line.length - 1] === 0x20) this._erase(1);
    while (this._line.length && this._line[this._line.length - 1] !== 0x20) this._erase(1);
  }
  _eraseLine() {
    while (this._line.length) this._erase(1);
  }

  _deliverLine(withNewline) {
    // The pending line already includes the NL when withNewline; if delivered via
    // ^D on a non-empty line, there's no trailing NL.
    const bytes = this._line;
    this._line = [];
    if (bytes.length) this.toProgram(Buffer.from(bytes));
    void withNewline;
  }

  _echo(buf) { this.toTerminal(buf); }

  // ---- program -> terminal (output post-processing) ----
  outputFromProgram(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!(this.flags.OPOST && this.flags.ONLCR)) { this.toTerminal(buf); return; }
    // ONLCR: map every \n (not already preceded by \r) to \r\n.
    const out = [];
    let last = -1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a && last !== 0x0d) out.push(0x0d);
      out.push(buf[i]);
      last = buf[i];
    }
    this.toTerminal(Buffer.from(out));
  }
}

module.exports = { LineDiscipline, CC, DEFAULT_FLAGS };
