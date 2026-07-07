// Minimal faithful ios_system runtime — the thread_stdout model, extracted.
// Real BSD command sources (cat.c/wc.c/grep.c, unmodified from the ios_system
// tree) #include "ios_error.h", which redirects libc calls to these ios_* symbols.
// We provide just enough of them for real coreutils to run in-process on a pthread
// with per-thread stdio, exactly as ios_system does — without pulling in the whole
// 4100-line ios_system.m + Foundation.
#ifndef IOS_RUNTIME_H
#define IOS_RUNTIME_H
#include <stdio.h>
#include <unistd.h>
#include <signal.h>

// Per-command thread-local streams (ios_error.h declares these extern).
extern __thread FILE *thread_stdin;
extern __thread FILE *thread_stdout;
extern __thread FILE *thread_stderr;

// Set by the bridge before calling a command; read back after it exits (even when
// the command calls exit() -> ios_exit() -> pthread_exit()).
extern __thread int tl_exit_code;
extern __thread const char *tl_progname;

#endif
