// Minimal ios_system runtime. Implements the ios_* functions that ios_error.h
// redirects libc to, using real libc against the per-thread streams. This file
// deliberately does NOT include ios_error.h (that would rewrite our own libc calls).
#include "ios_runtime.h"
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <pthread.h>

__thread FILE *thread_stdin;
__thread FILE *thread_stdout;
__thread FILE *thread_stderr;
__thread int tl_exit_code;
__thread const char *tl_progname;

// Map a command's notion of stdout/stderr/stdin onto its thread-local stream.
static FILE *redir(FILE *s) {
  if (s == stdout) return thread_stdout;
  if (s == stderr) return thread_stderr;
  if (s == stdin)  return thread_stdin;
  return s;
}

// exit()/_exit()/abort() -> unwind this command's thread (cleanup handler in the
// bridge closes thread_stdout so the reader sees EOF). Never kills the process.
void ios_exit(int code) {
  tl_exit_code = code;
  pthread_exit(NULL);
}

// write() -> route fd 1/2 to the thread streams; any other fd is already the real
// pipe fd (e.g. fileno(thread_stdout)) so pass it through.
ssize_t ios_write(int fd, const void *buf, size_t n) {
  if (fd == STDOUT_FILENO && thread_stdout) return write(fileno(thread_stdout), buf, n);
  if (fd == STDERR_FILENO && thread_stderr) return write(fileno(thread_stderr), buf, n);
  return write(fd, buf, n);
}
size_t ios_fwrite(const void *ptr, size_t size, size_t nitems, FILE *stream) {
  return fwrite(ptr, size, nitems, redir(stream));
}
int ios_puts(const char *s) { int r = fputs(s, thread_stdout); fputc('\n', thread_stdout); return r; }
int ios_fputs(const char *s, FILE *stream) { return fputs(s, redir(stream)); }
int ios_fputc(int c, FILE *stream) { return fputc(c, redir(stream)); }
int ios_putw(int w, FILE *stream) { return putw(w, redir(stream)); }
int ios_fflush(FILE *stream) { return fflush(redir(stream)); }

// Environment + misc — real libc is fine for the PoC.
char *ios_getenv(const char *name) { return getenv(name); }
int ios_setenv(const char *n, const char *v, int o) { return setenv(n, v, o); }
int ios_unsetenv(const char *n) { return unsetenv(n); }
int ios_putenv(char *s) { return putenv(s); }
int ios_fchdir(const int fd) { return fchdir(fd); }
int ios_isatty(int fd) { (void)fd; return 0; }              // never a tty here
sig_t ios_signal(int sig, sig_t fn) { (void)sig; (void)fn; return SIG_DFL; } // don't touch process signals
int ios_dup2(int a, int b) { return (b <= 2) ? b : dup2(a, b); }  // never steal fd 0/1/2

// Process-model stubs (real coreutils happy-paths don't call these).
int ios_killpid(pid_t p, int s) { (void)p; (void)s; return 0; }
int ios_kill(void) { return 0; }
FILE *ios_popen(const char *c, const char *t) { (void)c; (void)t; return NULL; }
int ios_system(const char *c) { (void)c; return -1; }
int ios_execv(const char *p, char *const a[]) { (void)p; (void)a; return -1; }
int ios_execve(const char *p, char *const a[], char **e) { (void)p; (void)a; (void)e; return -1; }
const char *ios_progname(void) { return tl_progname ? tl_progname : "cmd"; }
int ios_getCommandStatus(void) { return tl_exit_code; }

// ---- err.h / getprogname overrides ------------------------------------------
// ios_error.h leaves err()/warn()/getprogname() as libc, so their output would
// otherwise hit the REAL fd 2 (and print "node:" as the program name). Override
// them here so error output is ALSO isolated to the thread stream and carries the
// right program name. Intra-bundle references bind to these; Node's own libc
// err()/getprogname() are unaffected (two-level namespace).
#include <errno.h>

const char *getprogname(void) { return tl_progname ? tl_progname : "cmd"; }
void setprogname(const char *p) { tl_progname = p; }

static void vwarnc_(int code, const char *fmt, va_list ap) {
  fprintf(thread_stderr, "%s: ", tl_progname ? tl_progname : "cmd");
  if (fmt) vfprintf(thread_stderr, fmt, ap);
  if (code >= 0) fprintf(thread_stderr, ": %s", strerror(code));
  fputc('\n', thread_stderr);
  fflush(thread_stderr);
}
void warn(const char *fmt, ...)  { va_list ap; va_start(ap, fmt); vwarnc_(errno, fmt, ap); va_end(ap); }
void warnx(const char *fmt, ...) { va_list ap; va_start(ap, fmt); vwarnc_(-1, fmt, ap); va_end(ap); }
void err(int ev, const char *fmt, ...)  { va_list ap; va_start(ap, fmt); vwarnc_(errno, fmt, ap); va_end(ap); ios_exit(ev); }
void errx(int ev, const char *fmt, ...) { va_list ap; va_start(ap, fmt); vwarnc_(-1, fmt, ap); va_end(ap); ios_exit(ev); }
