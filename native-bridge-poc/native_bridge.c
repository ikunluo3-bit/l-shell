// native_bridge.c — PoC: Node child_process → in-process native command, streaming.
//
// Proves (Node 18.20.4 --jitless, same N-API/pthread/libuv model as nodejs-mobile):
//   spawn -> N-API dispatch -> pthread running a command_main() whose stdio is
//   THREAD-LOCAL (__thread FILE*, exactly ios_system's model) -> a reader thread
//   drains the command's stdout pipe -> chunks forwarded to JS via a
//   napi_threadsafe_function (never touching V8 off-thread) -> arrive PROGRESSIVELY.
//
// Risk points deliberately exercised: streaming vs batch, fd isolation from libuv's
// real fd 1, concurrent commands without stdio cross-talk, stdin delivery, exit
// codes, cooperative interrupt.
#include <node_api.h>
#include <pthread.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include "ios-cmds/ios_runtime.h"   // shared thread_stdout/stdin/stderr + tl_exit_code

// Real ios_system command entry points (real BSD coreutils, unmodified sources).
extern int cat_main(int argc, char **argv);
extern int wc_main(int argc, char **argv);
extern int grep_main(int argc, char **argv);

// ---- demo "native commands" (each an int name_main(argc, argv)) --------------
// They only ever touch thread_stdin/thread_stdout/thread_stderr — the ported model.

typedef struct cmd_ctx cmd_ctx;
static __thread volatile sig_atomic_t *tl_cancel;          // this command's cancel flag

// democount N  -> writes "tick i\n" every 80ms, i=1..N. Proves STREAMING.
static int democount_main(int argc, char **argv) {
  int n = (argc > 1) ? atoi(argv[1]) : 3;
  for (int i = 1; i <= n; i++) {
    if (tl_cancel && *tl_cancel) return 130;      // cooperative cancel
    fprintf(thread_stdout, "tick %d\n", i);
    fflush(thread_stdout);
    usleep(80 * 1000);
  }
  return 0;
}

// democat -> echo thread_stdin lines to thread_stdout until EOF. Proves stdin.
static int democat_main(int argc, char **argv) {
  (void)argc; (void)argv;
  char line[1024];
  while (fgets(line, sizeof line, thread_stdin)) {
    fprintf(thread_stdout, "echo: %s", line);
    fflush(thread_stdout);
  }
  return 0;
}

// demofail -> write to stderr, exit 3. Proves exit codes + stderr routing.
static int demofail_main(int argc, char **argv) {
  (void)argc; (void)argv;
  fprintf(thread_stderr, "boom on stderr\n");
  fflush(thread_stderr);
  return 3;
}

// demospin -> loop forever until cancelled. Proves cooperative interrupt.
static int demospin_main(int argc, char **argv) {
  (void)argc; (void)argv;
  int i = 0;
  for (;;) {
    if (tl_cancel && *tl_cancel) return 130;
    fprintf(thread_stdout, "spin %d\n", ++i);
    fflush(thread_stdout);
    usleep(50 * 1000);
  }
  return 0;
}

// demoleak -> deliberately writes to the REAL fd 1 (printf), NOT thread_stdout.
// This is the NEGATIVE control: it proves WHY commands must be recompiled to the
// ported (thread_stdout) model — an un-ported command leaks into Node's stdout.
static int demoleak_main(int argc, char **argv) {
  (void)argc; (void)argv;
  printf("LEAKED-TO-REAL-FD1\n");   // real libc stdout == Node's fd 1
  fflush(stdout);
  return 0;
}

static int (*resolve_main(const char *name))(int, char **) {
  // demo commands (mechanism tests)
  if (!strcmp(name, "democount")) return democount_main;
  if (!strcmp(name, "democat"))   return democat_main;
  if (!strcmp(name, "demofail"))  return demofail_main;
  if (!strcmp(name, "demospin"))  return demospin_main;
  if (!strcmp(name, "demoleak"))  return demoleak_main;
  // REAL ios_system coreutils (unmodified BSD sources)
  if (!strcmp(name, "cat"))       return cat_main;
  if (!strcmp(name, "wc"))        return wc_main;
  if (!strcmp(name, "grep"))      return grep_main;
  return NULL;
}

// ---- dispatch context --------------------------------------------------------
struct cmd_ctx {
  int argc;
  char **argv;
  int (*main_fn)(int, char **);
  int stdout_pipe[2];   // cmd writes [1] (thread_stdout); reader reads [0]
  int stdin_pipe[2];    // JS writes [1]; cmd reads [0] (thread_stdin)
  int exit_code;
  volatile sig_atomic_t cancel;
  pthread_t cmd_thread;
  pthread_t reader_thread;
  napi_threadsafe_function tsfn_data;  // wraps JS onData(buffer)
  napi_threadsafe_function tsfn_exit;  // wraps JS onExit(code)
};

// message handed to the data tsfn
typedef struct { char *buf; size_t len; } data_msg;

// ---- command thread ----------------------------------------------------------
// Runs whether the command RETURNS or calls exit()->ios_exit()->pthread_exit():
// the cleanup handler closes thread_stdout (reader sees EOF) and records the code.
static void command_cleanup(void *arg) {
  cmd_ctx *c = (cmd_ctx *)arg;
  if (thread_stdout) { fflush(thread_stdout); fclose(thread_stdout); }
  if (thread_stdin)  { fclose(thread_stdin); }
  c->exit_code = tl_exit_code;
}

static void *run_command(void *arg) {
  cmd_ctx *c = (cmd_ctx *)arg;
  // Bind this command's stdio to its own pipes — thread-local, invisible to libuv.
  thread_stdout = fdopen(c->stdout_pipe[1], "w");
  thread_stdin  = fdopen(c->stdin_pipe[0],  "r");
  thread_stderr = thread_stdout;             // merge stderr into stdout for the PoC
  tl_cancel = &c->cancel;
  tl_exit_code = 0;
  tl_progname = c->argv[0];

  pthread_cleanup_push(command_cleanup, c);
  int rc = c->main_fn(c->argc, c->argv);
  tl_exit_code = rc;              // normal-return path
  pthread_cleanup_pop(1);         // runs command_cleanup (also fires on pthread_exit)
  return NULL;
}

// call_js for data chunks — runs ON the Node thread.
static void data_call_js(napi_env env, napi_value cb, void *ctx, void *data) {
  (void)ctx;
  data_msg *m = (data_msg *)data;
  if (env != NULL && cb != NULL) {
    napi_value undef, buf, argv1;
    napi_get_undefined(env, &undef);
    void *copy;
    napi_create_buffer_copy(env, m->len, m->buf, &copy, &buf);
    argv1 = buf;
    napi_call_function(env, undef, cb, 1, &argv1, NULL);
  }
  free(m->buf);
  free(m);
}

// call_js for exit — runs ON the Node thread.
static void exit_call_js(napi_env env, napi_value cb, void *ctx, void *data) {
  (void)ctx;
  int code = (int)(intptr_t)data;
  if (env != NULL && cb != NULL) {
    napi_value undef, arg;
    napi_get_undefined(env, &undef);
    napi_create_int32(env, code, &arg);
    napi_call_function(env, undef, cb, 1, &arg, NULL);
  }
}

// ---- reader thread: drain stdout pipe, forward chunks, then deliver exit ------
static void *run_reader(void *arg) {
  cmd_ctx *c = (cmd_ctx *)arg;
  char buf[4096];
  ssize_t n;
  while ((n = read(c->stdout_pipe[0], buf, sizeof buf)) > 0) {
    data_msg *m = (data_msg *)malloc(sizeof(data_msg));
    m->buf = (char *)malloc((size_t)n);
    memcpy(m->buf, buf, (size_t)n);
    m->len = (size_t)n;
    // blocking call so we never drop a chunk under backpressure
    napi_call_threadsafe_function(c->tsfn_data, m, napi_tsfn_blocking);
  }
  // EOF: all data delivered. Collect exit code, then fire exit (ordered after data).
  pthread_join(c->cmd_thread, NULL);
  napi_call_threadsafe_function(c->tsfn_exit, (void *)(intptr_t)c->exit_code,
                                napi_tsfn_blocking);
  // Release our tsfn refs so Node can let them go.
  napi_release_threadsafe_function(c->tsfn_data, napi_tsfn_release);
  napi_release_threadsafe_function(c->tsfn_exit, napi_tsfn_release);
  close(c->stdout_pipe[0]);
  close(c->stdin_pipe[1]);   // if JS didn't close it
  // free argv
  for (int i = 0; i < c->argc; i++) free(c->argv[i]);
  free(c->argv);
  free(c);
  return NULL;
}

// ---- N-API: dispatch(name, argv[], onData, onExit) -> handle{id} -------------
// We wrap the ctx pointer as an external so writeStdin/cancel can find it.

static napi_value js_dispatch(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  char name[64];
  size_t nlen;
  napi_get_value_string_utf8(env, args[0], name, sizeof name, &nlen);
  int (*mainfn)(int, char **) = resolve_main(name);
  if (!mainfn) {
    napi_throw_error(env, NULL, "unknown demo command");
    return NULL;
  }

  cmd_ctx *c = (cmd_ctx *)calloc(1, sizeof(cmd_ctx));
  c->main_fn = mainfn;
  c->cancel = 0;

  // build argv (argv[0]=name, then the JS array)
  uint32_t extra = 0;
  napi_get_array_length(env, args[1], &extra);
  c->argc = 1 + (int)extra;
  c->argv = (char **)calloc((size_t)c->argc + 1, sizeof(char *));
  c->argv[0] = strdup(name);
  for (uint32_t i = 0; i < extra; i++) {
    napi_value el;
    napi_get_element(env, args[1], i, &el);
    char a[256]; size_t al;
    napi_get_value_string_utf8(env, el, a, sizeof a, &al);
    c->argv[1 + i] = strdup(a);
  }

  if (pipe(c->stdout_pipe) != 0 || pipe(c->stdin_pipe) != 0) {
    napi_throw_error(env, NULL, "pipe() failed");
    return NULL;
  }

  napi_value res_name;
  napi_create_string_utf8(env, "native_bridge_cb", NAPI_AUTO_LENGTH, &res_name);
  napi_create_threadsafe_function(env, args[2], NULL, res_name, 0, 1, NULL, NULL,
                                  NULL, data_call_js, &c->tsfn_data);
  napi_create_threadsafe_function(env, args[3], NULL, res_name, 0, 1, NULL, NULL,
                                  NULL, exit_call_js, &c->tsfn_exit);

  pthread_create(&c->cmd_thread, NULL, run_command, c);
  pthread_create(&c->reader_thread, NULL, run_reader, c);
  pthread_detach(c->reader_thread);   // reader self-cleans (joins cmd, frees ctx)

  // Return the ctx pointer as an external handle.
  napi_value handle;
  napi_create_external(env, c, NULL, NULL, &handle);
  return handle;
}

static cmd_ctx *unwrap(napi_env env, napi_value ext) {
  void *p = NULL;
  napi_get_value_external(env, ext, &p);
  return (cmd_ctx *)p;
}

static napi_value js_write_stdin(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  cmd_ctx *c = unwrap(env, args[0]);
  if (!c) return NULL;
  void *data; size_t len;
  napi_get_buffer_info(env, args[1], &data, &len);
  ssize_t off = 0;
  while ((size_t)off < len) {
    ssize_t w = write(c->stdin_pipe[1], (char *)data + off, len - (size_t)off);
    if (w < 0) { if (errno == EINTR) continue; break; }
    off += w;
  }
  return NULL;
}

static napi_value js_close_stdin(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  cmd_ctx *c = unwrap(env, args[0]);
  if (c) close(c->stdin_pipe[1]);
  return NULL;
}

static napi_value js_cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  cmd_ctx *c = unwrap(env, args[0]);
  if (c) {
    c->cancel = 1;             // cooperative flag (checked at command loop points)
    close(c->stdin_pipe[1]);   // also wake a command blocked on stdin read
  }
  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, NULL, 0, js_dispatch, NULL, &fn);
  napi_set_named_property(env, exports, "dispatch", fn);
  napi_create_function(env, NULL, 0, js_write_stdin, NULL, &fn);
  napi_set_named_property(env, exports, "writeStdin", fn);
  napi_create_function(env, NULL, 0, js_close_stdin, NULL, &fn);
  napi_set_named_property(env, exports, "closeStdin", fn);
  napi_create_function(env, NULL, 0, js_cancel, NULL, &fn);
  napi_set_named_property(env, exports, "cancel", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
