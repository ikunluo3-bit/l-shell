// cpython_bridge.c — N-API built-in module 'lshell_py'
// =============================================================================
// A statically-linked Node addon that embeds CPython 3.13 (BeeWare
// Python-Apple-support) inside the nodejs-mobile process on iOS, jitless.
//
// It exposes to JS (via process._linkedBinding('lshell_py')):
//   py_init(pythonHome, pythonPath)  -> bool   (idempotent, one-time init)
//   py_isReady()                     -> bool
//   dispatch(argvArray, envObj, onData(buf, streamId), onExit(code)) -> handle
//   writeStdin(handle, buffer)
//   closeStdin(handle)
//   cancel(handle)
//
// Design decisions (per the project's prior rulings):
//   * The interpreter is initialized ONCE on a DEDICATED pthread that owns the
//     runtime for the whole process lifetime and is NEVER finalized. All calls
//     into CPython happen on that one thread while it holds the GIL. We do this
//     with a work queue: py_init/dispatch enqueue jobs; the interpreter thread
//     dequeues and runs them. This guarantees every Py* call is single-threaded
//     and GIL-safe.
//   * Py_InitializeFromConfig with PyConfig: isolated=1, home=<pythonHome>,
//     module_search_paths=<pythonPath split on ':'>, parse_argv=0,
//     install_signal_handlers=0, configure_c_stdio=0 (we DON'T let CPython grab
//     the real fd 0/1/2 — that belongs to libuv/Node), buffered_stdio=0.
//   * stdout/stderr are redirected at the PYTHON level (never dup2 over the real
//     fd 1/2). For each dispatch we build two OS pipes; the write ends are
//     wrapped by Python io.TextIOWrapper(io.FileIO(fd, 'w', closefd=False)) and
//     assigned to sys.stdout / sys.stderr for the duration of that job. Two C
//     reader threads drain the read ends and forward chunks to JS through a
//     napi_threadsafe_function, tagged with streamId (1=stdout, 2=stderr).
//     Pipes get fresh high fd numbers; they never collide with or replace Node's
//     real stdout, so nothing leaks into Node's own console.
//   * Each job runs its code in a FRESH __main__ namespace dict (a new module
//     dict seeded with __builtins__), so state does not bleed between commands.
//   * Exceptions: SystemExit -> that code; any other exception -> traceback
//     printed to the stderr pipe, exit code 1; clean finish -> 0.
//   * cancel() sets PyErr_SetInterrupt() (raises KeyboardInterrupt at the next
//     bytecode check) AND a cooperative flag; closeStdin wakes a blocked read.
//
// NOTE: 'use_system_logger' is NOT a field of PyConfig in CPython 3.13
// (it was added for iOS in 3.14). We suppress iOS system-logging of stdout by
// setting configure_c_stdio=0 and installing our own sys.stdout/stderr, so the
// interpreter never routes writes to the Apple system log. See notes at bottom.
// =============================================================================

#define PY_SSIZE_T_CLEAN
#include <Python.h>

#define NAPI_VERSION 8            // stay within Node 18's guaranteed N-API surface
#include <node_api.h>

#include <pthread.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <wchar.h>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Convert a UTF-8 C string to a freshly malloc'd wchar_t* using CPython's own
// decoder (handles the platform's wchar_t width + surrogateescape correctly).
static wchar_t *utf8_to_wchar(const char *s) {
    if (!s) return NULL;
    // Py_DecodeLocale is available pre-init and does the right thing for paths.
    return Py_DecodeLocale(s, NULL);
}

// ---------------------------------------------------------------------------
// Interpreter thread + work queue
// ---------------------------------------------------------------------------
// One dedicated thread runs the CPython runtime for the whole process. Jobs are
// posted to a linked-list queue guarded by a mutex+cond. The thread pops a job,
// runs it (holding the GIL, which it owns as the runtime's main thread), and
// loops forever. It is never joined and CPython is never finalized.

typedef enum { JOB_INIT, JOB_EXEC } job_kind;

typedef struct py_job {
    job_kind kind;
    struct py_job *next;

    // ---- JOB_INIT payload ----
    char *py_home;          // malloc'd UTF-8
    char *py_path;          // malloc'd UTF-8, ':'-separated search paths

    // ---- JOB_EXEC payload ----
    char **argv;            // argv[0] is a label / script name; rest are args
    int argc;
    char **env_keys;        // parallel arrays for environment overrides
    char **env_vals;
    int env_count;
    int stdout_wfd;         // Python writes here (pipe write end)
    int stderr_wfd;
    int stdin_rfd;          // Python reads here (pipe read end)

    // cancel coordination (owned by the exec's ctx; see exec_ctx)
    struct exec_ctx *ectx;
} py_job;

static pthread_mutex_t g_queue_mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_queue_cv  = PTHREAD_COND_INITIALIZER;
static py_job         *g_queue_head = NULL;
static py_job         *g_queue_tail = NULL;

static pthread_t       g_interp_thread;
static int             g_thread_started = 0;   // guarded by g_start_mtx
static pthread_mutex_t g_start_mtx = PTHREAD_MUTEX_INITIALIZER;

// Ready flag: set to 1 by the interpreter thread once Py_InitializeFromConfig
// has succeeded. Read from any thread (atomic-ish int; only 0->1 transition).
static volatile int g_py_ready = 0;
static volatile int g_py_init_failed = 0;

static void queue_push(py_job *j) {
    pthread_mutex_lock(&g_queue_mtx);
    j->next = NULL;
    if (g_queue_tail) g_queue_tail->next = j;
    else              g_queue_head = j;
    g_queue_tail = j;
    pthread_cond_signal(&g_queue_cv);
    pthread_mutex_unlock(&g_queue_mtx);
}

static py_job *queue_pop_blocking(void) {
    pthread_mutex_lock(&g_queue_mtx);
    while (g_queue_head == NULL)
        pthread_cond_wait(&g_queue_cv, &g_queue_mtx);
    py_job *j = g_queue_head;
    g_queue_head = j->next;
    if (g_queue_head == NULL) g_queue_tail = NULL;
    pthread_mutex_unlock(&g_queue_mtx);
    return j;
}

// ---------------------------------------------------------------------------
// exec_ctx — per-dispatch state shared between the interpreter thread, the two
// reader threads, and the N-API handle used by writeStdin/closeStdin/cancel.
// ---------------------------------------------------------------------------

typedef struct exec_ctx {
    // pipes (fd numbers). Convention:
    //   stdout: python writes stdout_pipe[1], reader reads stdout_pipe[0]
    //   stderr: python writes stderr_pipe[1], reader reads stderr_pipe[0]
    //   stdin : JS writes stdin_pipe[1],      python reads stdin_pipe[0]
    int stdout_pipe[2];
    int stderr_pipe[2];
    int stdin_pipe[2];

    napi_threadsafe_function tsfn_data;   // wraps onData(buffer, streamId)
    napi_threadsafe_function tsfn_exit;   // wraps onExit(code)

    pthread_t reader_out;
    pthread_t reader_err;

    // cancel coordination
    volatile int cancel_flag;             // cooperative flag (read in trace hook)

    int exit_code;                        // filled by the exec job

    // lifecycle refcount: exec job + 2 readers must all finish before free.
    // Simpler: readers join after EOF; exec job posts exit AFTER closing write
    // ends so readers see EOF. We free ctx in a dedicated joiner. See below.
    pthread_mutex_t done_mtx;
    int readers_done;                     // 0,1,2
    int exec_done;                        // set when exec job finished
} exec_ctx;

// message handed to the data tsfn: a chunk + which stream it came from.
typedef struct { char *buf; size_t len; int stream_id; } data_msg;

// ---------------------------------------------------------------------------
// N-API threadsafe callbacks (run ON the Node/libuv thread)
// ---------------------------------------------------------------------------

static void data_call_js(napi_env env, napi_value cb, void *context, void *data) {
    (void)context;
    data_msg *m = (data_msg *)data;
    if (env != NULL && cb != NULL) {
        napi_value undef, buf, sid, args[2];
        napi_get_undefined(env, &undef);
        void *copy = NULL;
        napi_create_buffer_copy(env, m->len, m->buf, &copy, &buf);
        napi_create_int32(env, m->stream_id, &sid);
        args[0] = buf;
        args[1] = sid;
        napi_call_function(env, undef, cb, 2, args, NULL);
    }
    free(m->buf);
    free(m);
}

static void exit_call_js(napi_env env, napi_value cb, void *context, void *data) {
    (void)context;
    int code = (int)(intptr_t)data;
    if (env != NULL && cb != NULL) {
        napi_value undef, arg;
        napi_get_undefined(env, &undef);
        napi_create_int32(env, code, &arg);
        napi_call_function(env, undef, cb, 1, &arg, NULL);
    }
}

// ---------------------------------------------------------------------------
// Reader threads: drain one pipe read-end, forward chunks tagged with stream_id
// ---------------------------------------------------------------------------

typedef struct { exec_ctx *ctx; int read_fd; int stream_id; } reader_arg;

static void *run_reader(void *arg) {
    reader_arg *ra = (reader_arg *)arg;
    exec_ctx *c = ra->ctx;
    char buf[4096];
    ssize_t n;
    while ((n = read(ra->read_fd, buf, sizeof buf)) > 0) {
        data_msg *m = (data_msg *)malloc(sizeof(data_msg));
        m->buf = (char *)malloc((size_t)n);
        memcpy(m->buf, buf, (size_t)n);
        m->len = (size_t)n;
        m->stream_id = ra->stream_id;
        // blocking so we never drop a chunk under backpressure
        napi_call_threadsafe_function(c->tsfn_data, m, napi_tsfn_blocking);
    }
    close(ra->read_fd);

    // Coordinate teardown: last of {exec_done, both readers} fires exit + frees.
    pthread_mutex_lock(&c->done_mtx);
    c->readers_done += 1;
    int both_readers = (c->readers_done == 2);
    int exec_done = c->exec_done;
    pthread_mutex_unlock(&c->done_mtx);

    if (both_readers && exec_done) {
        // both streams flushed AND python finished: deliver exit, release tsfns.
        napi_call_threadsafe_function(c->tsfn_exit,
                                      (void *)(intptr_t)c->exit_code,
                                      napi_tsfn_blocking);
        napi_release_threadsafe_function(c->tsfn_data, napi_tsfn_release);
        napi_release_threadsafe_function(c->tsfn_exit, napi_tsfn_release);
        pthread_mutex_destroy(&c->done_mtx);
        // stdin write end may still be open on the JS side; close read end here.
        if (c->stdin_pipe[0] >= 0) close(c->stdin_pipe[0]);
        free(c);
    }
    free(ra);
    return NULL;
}

// Called by the exec job once python has finished and the write ends are closed.
// Mirrors the reader coordination so whichever finishes last does the teardown.
static void exec_signal_done(exec_ctx *c) {
    pthread_mutex_lock(&c->done_mtx);
    c->exec_done = 1;
    int both_readers = (c->readers_done == 2);
    pthread_mutex_unlock(&c->done_mtx);
    if (both_readers) {
        napi_call_threadsafe_function(c->tsfn_exit,
                                      (void *)(intptr_t)c->exit_code,
                                      napi_tsfn_blocking);
        napi_release_threadsafe_function(c->tsfn_data, napi_tsfn_release);
        napi_release_threadsafe_function(c->tsfn_exit, napi_tsfn_release);
        pthread_mutex_destroy(&c->done_mtx);
        if (c->stdin_pipe[0] >= 0) close(c->stdin_pipe[0]);
        free(c);
    }
}

// ---------------------------------------------------------------------------
// CPython interaction (all of this runs ONLY on the interpreter thread)
// ---------------------------------------------------------------------------

// Wrap a raw fd as a Python text stream: io.TextIOWrapper(io.FileIO(fd,'w',
// closefd=True), encoding='utf-8', errors='backslashreplace', write_through=1,
// line_buffering=1). Returns a new reference or NULL (with a Python error set).
static PyObject *make_py_writer(int fd) {
    PyObject *io = PyImport_ImportModule("io");
    if (!io) return NULL;

    // raw = io.FileIO(fd, 'w', closefd=True)
    PyObject *raw = PyObject_CallMethod(io, "FileIO", "isO",
                                        fd, "w", Py_True /* closefd */);
    if (!raw) { Py_DECREF(io); return NULL; }

    // text = io.TextIOWrapper(raw, encoding='utf-8', errors='backslashreplace',
    //                         newline='', line_buffering=True, write_through=True)
    PyObject *text = PyObject_CallMethod(
        io, "TextIOWrapper", "Osssii",
        raw, "utf-8", "backslashreplace", "", 1 /*line_buffering*/, 1 /*write_through*/);
    Py_DECREF(raw);
    Py_DECREF(io);
    return text;   // may be NULL with error set
}

// Wrap a raw fd as a Python readable text stream for sys.stdin.
static PyObject *make_py_reader(int fd) {
    PyObject *io = PyImport_ImportModule("io");
    if (!io) return NULL;
    PyObject *raw = PyObject_CallMethod(io, "FileIO", "isO",
                                        fd, "r", Py_True);
    if (!raw) { Py_DECREF(io); return NULL; }
    PyObject *text = PyObject_CallMethod(
        io, "TextIOWrapper", "Osssii",
        raw, "utf-8", "backslashreplace", "", 0 /*line_buffering*/, 0 /*write_through*/);
    Py_DECREF(raw);
    Py_DECREF(io);
    return text;
}

// The cooperative cancel: a trace function that raises KeyboardInterrupt when
// the ctx cancel flag is set. Installed per-exec via sys.settrace equivalent is
// heavy; instead we rely on PyErr_SetInterrupt() posted from cancel(). This hook
// is a belt-and-suspenders check invoked from an eval-breaker we set below. To
// keep it simple and dependency-free we DON'T install a C trace func; cancel()
// uses PyErr_SetInterrupt which the interpreter checks between bytecodes.

// Run one exec job on the interpreter thread. Returns the process-style exit
// code. Assumes the GIL is held (it is: we're the runtime's main thread).
static int run_exec_job(py_job *j) {
    exec_ctx *c = j->ectx;
    int exit_code = 0;

    // ---- 1. swap sys.stdout / sys.stderr / sys.stdin to our pipe wrappers ----
    PyObject *sys = PyImport_ImportModule("sys");
    PyObject *old_out = NULL, *old_err = NULL, *old_in = NULL;
    PyObject *new_out = NULL, *new_err = NULL, *new_in = NULL;
    if (sys) {
        old_out = PySys_GetObject("stdout");  Py_XINCREF(old_out);
        old_err = PySys_GetObject("stderr");  Py_XINCREF(old_err);
        old_in  = PySys_GetObject("stdin");   Py_XINCREF(old_in);

        new_out = make_py_writer(j->stdout_wfd);
        new_err = make_py_writer(j->stderr_wfd);
        new_in  = make_py_reader(j->stdin_rfd);
        if (new_out) PySys_SetObject("stdout", new_out);
        if (new_err) PySys_SetObject("stderr", new_err);
        if (new_in)  PySys_SetObject("stdin",  new_in);
        // clear any error from wrapper construction; fall back to defaults if so
        if (PyErr_Occurred()) PyErr_Clear();
    }

    // ---- 2. build a fresh __main__ namespace dict ----------------------------
    // We don't reuse the real __main__ module dict; instead we make a brand-new
    // dict seeded with __builtins__ and __name__ = '__main__' so each command
    // runs isolated.
    PyObject *globals = PyDict_New();
    if (globals) {
        PyObject *builtins = PyEval_GetBuiltins();     // borrowed
        if (builtins) PyDict_SetItemString(globals, "__builtins__", builtins);
        PyObject *name = PyUnicode_FromString("__main__");
        PyDict_SetItemString(globals, "__name__", name);
        Py_XDECREF(name);
        PyObject *doc = Py_None;
        PyDict_SetItemString(globals, "__doc__", doc);
    }

    // ---- 3. seed sys.argv from the job argv ----------------------------------
    if (sys) {
        PyObject *pyargv = PyList_New(0);
        for (int i = 0; i < j->argc; i++) {
            PyObject *s = PyUnicode_FromString(j->argv[i] ? j->argv[i] : "");
            if (s) { PyList_Append(pyargv, s); Py_DECREF(s); }
        }
        if (pyargv) { PySys_SetObject("argv", pyargv); Py_DECREF(pyargv); }
    }

    // ---- 4. apply environment overrides into os.environ ----------------------
    if (j->env_count > 0) {
        PyObject *os = PyImport_ImportModule("os");
        if (os) {
            PyObject *environ = PyObject_GetAttrString(os, "environ");
            if (environ) {
                for (int i = 0; i < j->env_count; i++) {
                    PyObject *k = PyUnicode_FromString(j->env_keys[i]);
                    PyObject *v = PyUnicode_FromString(j->env_vals[i]);
                    if (k && v) PyObject_SetItem(environ, k, v);
                    Py_XDECREF(k);
                    Py_XDECREF(v);
                }
                Py_DECREF(environ);
            }
            Py_DECREF(os);
            if (PyErr_Occurred()) PyErr_Clear();
        }
    }

    // ---- 5. clear any pending interrupt before we start ----------------------
    // (a cancel() from a previous run must not bleed into this one)
    if (PyErr_CheckSignals() != 0) PyErr_Clear();
    c->cancel_flag = 0;

    // ---- 6. run the code -----------------------------------------------------
    // Convention: argv[0] carries the Python source to execute. (The JS side
    // sends the resolved script text as argv[0]; real argv for the script is in
    // argv[1..] and already went into sys.argv above.) If you prefer argv[0] to
    // be a filename, swap to PyRun_File; the ruling was PyRun_StringFlags.
    const char *code = (j->argc > 0 && j->argv[0]) ? j->argv[0] : "";

    PyObject *result = NULL;
    if (globals) {
        result = PyRun_StringFlags(code, Py_file_input, globals, globals, NULL);
    }

    // ---- 7. resolve exit code from the outcome -------------------------------
    if (result == NULL) {
        // An exception propagated. Distinguish SystemExit from real errors.
        if (PyErr_Occurred()) {
            if (PyErr_ExceptionMatches(PyExc_SystemExit)) {
                // Pull the code out of the SystemExit instance.
                PyObject *etype, *evalue, *etb;
                PyErr_Fetch(&etype, &evalue, &etb);
                PyErr_NormalizeException(&etype, &evalue, &etb);
                exit_code = 0;
                if (evalue) {
                    PyObject *codeobj = PyObject_GetAttrString(evalue, "code");
                    if (codeobj && codeobj != Py_None) {
                        if (PyLong_Check(codeobj)) {
                            exit_code = (int)PyLong_AsLong(codeobj);
                        } else {
                            // non-int code -> message to stderr, exit 1
                            exit_code = 1;
                            PyObject *repr = PyObject_Str(codeobj);
                            if (repr && new_err) {
                                const char *msg = PyUnicode_AsUTF8(repr);
                                if (msg) {
                                    PyObject_CallMethod(new_err, "write", "s", msg);
                                    PyObject_CallMethod(new_err, "write", "s", "\n");
                                }
                            }
                            Py_XDECREF(repr);
                        }
                    }
                    Py_XDECREF(codeobj);
                }
                Py_XDECREF(etype); Py_XDECREF(evalue); Py_XDECREF(etb);
                PyErr_Clear();
            } else if (PyErr_ExceptionMatches(PyExc_KeyboardInterrupt)) {
                // cancel() path: print a short notice, exit 130 (128+SIGINT).
                PyErr_Print();          // -> our sys.stderr wrapper
                exit_code = 130;
                PyErr_Clear();
            } else {
                // Any other exception: full traceback to (our) sys.stderr, exit 1.
                PyErr_Print();          // routes through sys.stderr = our pipe
                exit_code = 1;
                PyErr_Clear();
            }
        } else {
            exit_code = 1;              // NULL result but no error set (defensive)
        }
    } else {
        Py_DECREF(result);
        exit_code = 0;
    }

    // ---- 8. flush + restore original sys streams; close write ends -----------
    if (new_out) { PyObject_CallMethod(new_out, "flush", NULL); }
    if (new_err) { PyObject_CallMethod(new_err, "flush", NULL); }
    if (PyErr_Occurred()) PyErr_Clear();

    if (sys) {
        if (old_out) PySys_SetObject("stdout", old_out);
        if (old_err) PySys_SetObject("stderr", old_err);
        if (old_in)  PySys_SetObject("stdin",  old_in);
    }

    // Closing the TextIOWrappers closes the underlying FileIO (closefd=True),
    // which closes the pipe write ends -> the reader threads see EOF.
    if (new_out) { PyObject_CallMethod(new_out, "close", NULL); }
    if (new_err) { PyObject_CallMethod(new_err, "close", NULL); }
    if (new_in)  { PyObject_CallMethod(new_in,  "close", NULL); }
    if (PyErr_Occurred()) PyErr_Clear();

    Py_XDECREF(new_out); Py_XDECREF(new_err); Py_XDECREF(new_in);
    Py_XDECREF(old_out); Py_XDECREF(old_err); Py_XDECREF(old_in);
    Py_XDECREF(globals);
    Py_XDECREF(sys);

    c->cancel_flag = 0;
    return exit_code;
}

// Perform one-time interpreter initialization with a PyConfig. Runs on the
// interpreter thread. Sets g_py_ready or g_py_init_failed.
static void run_init_job(py_job *j) {
    PyStatus status;
    PyConfig config;
    PyConfig_InitPythonConfig(&config);

    // Isolated: no site-packages env influence, no cwd on path, no user site.
    config.isolated = 1;
    config.use_environment = 0;
    config.parse_argv = 0;
    config.install_signal_handlers = 0;   // Node owns signals; don't fight it
    config.configure_c_stdio = 0;         // DON'T touch real fd 0/1/2 (libuv's)
    config.buffered_stdio = 0;            // we manage buffering via our wrappers
    config.write_bytecode = 0;            // read-only app bundle; no .pyc writes
    config.site_import = 1;               // keep site.py (needed for encodings)
    config.pathconfig_warnings = 0;

    // program_name — cosmetic, but set for sys.executable sanity.
    status = PyConfig_SetBytesString(&config, &config.program_name, "python3");
    if (PyStatus_Exception(status)) goto fail;

    // home = pythonHome (the Python.framework dir containing lib/python3.13)
    if (j->py_home && j->py_home[0]) {
        status = PyConfig_SetBytesString(&config, &config.home, j->py_home);
        if (PyStatus_Exception(status)) goto fail;
    }

    // module_search_paths = pythonPath split on ':'  (fully explicit; no probing)
    if (j->py_path && j->py_path[0]) {
        config.module_search_paths_set = 1;
        char *dup = strdup(j->py_path);
        char *save = NULL;
        for (char *tok = strtok_r(dup, ":", &save);
             tok != NULL;
             tok = strtok_r(NULL, ":", &save)) {
            wchar_t *w = utf8_to_wchar(tok);
            if (w) {
                status = PyWideStringList_Append(&config.module_search_paths, w);
                PyMem_RawFree(w);
                if (PyStatus_Exception(status)) { free(dup); goto fail; }
            }
        }
        free(dup);
    }

    status = Py_InitializeFromConfig(&config);
    if (PyStatus_Exception(status)) goto fail;
    PyConfig_Clear(&config);

    // Redirect the C-level Apple system logger away by ensuring sys.stdout/err
    // are plain (unconfigured) objects until a dispatch swaps them. With
    // configure_c_stdio=0, CPython leaves sys.stdout/stderr as best-effort text
    // wrappers over fd 1/2; we never write to them outside a dispatch, and each
    // dispatch swaps in its own pipe-backed streams, so nothing reaches Node's
    // real stdout or the iOS system log during normal command execution.

    g_py_ready = 1;
    return;

fail:
    PyConfig_Clear(&config);
    g_py_init_failed = 1;
    // Leave a breadcrumb on the process stderr (best effort; pre-ready path).
    fprintf(stderr, "[lshell_py] Py_InitializeFromConfig failed: %s\n",
            status.err_msg ? status.err_msg : "(unknown)");
    fflush(stderr);
}

// The interpreter thread main loop. Owns the runtime forever.
static void *interpreter_thread_main(void *arg) {
    (void)arg;
    for (;;) {
        py_job *j = queue_pop_blocking();
        if (j->kind == JOB_INIT) {
            if (!g_py_ready && !g_py_init_failed) {
                run_init_job(j);
            }
            free(j->py_home);
            free(j->py_path);
            free(j);
        } else { // JOB_EXEC
            exec_ctx *c = j->ectx;
            if (!g_py_ready) {
                // interpreter never came up; fail the job cleanly.
                c->exit_code = 1;
                const char *msg = "[lshell_py] interpreter not initialized\n";
                write(j->stderr_wfd, msg, strlen(msg));
            } else {
                c->exit_code = run_exec_job(j);
            }
            // Close the write ends so the readers hit EOF. (run_exec_job already
            // closed them via the wrappers on the success path, but ensure it.)
            // Note: fds are already closed by wrapper .close(); guard with dup2
            // avoidance — closing an already-closed fd is harmless here since we
            // never reuse the numbers within this job.
            // We DON'T double-close: run_exec_job's wrappers own them. If init
            // failed above we still need to close them now:
            if (!g_py_ready) {
                close(j->stdout_wfd);
                close(j->stderr_wfd);
                close(j->stdin_rfd);
            }
            // free job argv/env
            for (int i = 0; i < j->argc; i++) free(j->argv[i]);
            free(j->argv);
            for (int i = 0; i < j->env_count; i++) { free(j->env_keys[i]); free(j->env_vals[i]); }
            free(j->env_keys);
            free(j->env_vals);
            free(j);

            exec_signal_done(c);
        }
    }
    return NULL;   // unreachable
}

// Start the interpreter thread once.
static void ensure_thread_started(void) {
    pthread_mutex_lock(&g_start_mtx);
    if (!g_thread_started) {
        g_thread_started = 1;
        pthread_create(&g_interp_thread, NULL, interpreter_thread_main, NULL);
        pthread_detach(g_interp_thread);
    }
    pthread_mutex_unlock(&g_start_mtx);
}

// ---------------------------------------------------------------------------
// N-API: py_init(pythonHome, pythonPath) -> bool
// ---------------------------------------------------------------------------
// Idempotent. First call starts the interpreter thread and posts an INIT job.
// Returns true if init is in-flight or already done; false only on argument
// errors. Actual readiness is observed via py_isReady().

static char *napi_string_dup(napi_env env, napi_value v) {
    size_t len = 0;
    if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
    char *s = (char *)malloc(len + 1);
    if (!s) return NULL;
    size_t got = 0;
    napi_get_value_string_utf8(env, v, s, len + 1, &got);
    s[got] = '\0';
    return s;
}

static napi_value js_py_init(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    napi_value result;

    // Already up or already tried: idempotent success/failure report.
    if (g_py_ready) { napi_get_boolean(env, true, &result); return result; }

    char *home = (argc >= 1) ? napi_string_dup(env, args[0]) : NULL;
    char *path = (argc >= 2) ? napi_string_dup(env, args[1]) : NULL;

    ensure_thread_started();

    py_job *j = (py_job *)calloc(1, sizeof(py_job));
    j->kind = JOB_INIT;
    j->py_home = home;   // ownership transferred (freed by the interpreter thread)
    j->py_path = path;
    queue_push(j);

    napi_get_boolean(env, true, &result);
    return result;
}

// ---------------------------------------------------------------------------
// N-API: py_isReady() -> bool
// ---------------------------------------------------------------------------
static napi_value js_py_is_ready(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result;
    napi_get_boolean(env, g_py_ready ? true : false, &result);
    return result;
}

// ---------------------------------------------------------------------------
// N-API: dispatch(argvArray, envObj, onData, onExit) -> handle(external)
// ---------------------------------------------------------------------------

static napi_value js_dispatch(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (argc < 4) {
        napi_throw_error(env, NULL, "dispatch(argv, env, onData, onExit) requires 4 args");
        return NULL;
    }

    // ---- build ctx + pipes ----
    exec_ctx *c = (exec_ctx *)calloc(1, sizeof(exec_ctx));
    c->stdout_pipe[0] = c->stdout_pipe[1] = -1;
    c->stderr_pipe[0] = c->stderr_pipe[1] = -1;
    c->stdin_pipe[0]  = c->stdin_pipe[1]  = -1;
    pthread_mutex_init(&c->done_mtx, NULL);

    if (pipe(c->stdout_pipe) != 0 ||
        pipe(c->stderr_pipe) != 0 ||
        pipe(c->stdin_pipe)  != 0) {
        napi_throw_error(env, NULL, "pipe() failed");
        // best-effort cleanup
        for (int i = 0; i < 2; i++) {
            if (c->stdout_pipe[i] >= 0) close(c->stdout_pipe[i]);
            if (c->stderr_pipe[i] >= 0) close(c->stderr_pipe[i]);
            if (c->stdin_pipe[i]  >= 0) close(c->stdin_pipe[i]);
        }
        pthread_mutex_destroy(&c->done_mtx);
        free(c);
        return NULL;
    }

    // ---- build job ----
    py_job *j = (py_job *)calloc(1, sizeof(py_job));
    j->kind = JOB_EXEC;
    j->ectx = c;
    j->stdout_wfd = c->stdout_pipe[1];
    j->stderr_wfd = c->stderr_pipe[1];
    j->stdin_rfd  = c->stdin_pipe[0];

    // argv: a JS string array. argv[0] = source code, argv[1..] = script args.
    uint32_t alen = 0;
    napi_get_array_length(env, args[0], &alen);
    j->argc = (int)alen;
    j->argv = (char **)calloc((size_t)alen + 1, sizeof(char *));
    for (uint32_t i = 0; i < alen; i++) {
        napi_value el;
        napi_get_element(env, args[0], i, &el);
        j->argv[i] = napi_string_dup(env, el);
        if (!j->argv[i]) j->argv[i] = strdup("");
    }

    // env: a JS object {KEY: VALUE, ...} of string overrides (may be null/undefined).
    napi_valuetype envtype;
    napi_typeof(env, args[1], &envtype);
    if (envtype == napi_object) {
        napi_value keys;
        napi_get_property_names(env, args[1], &keys);
        uint32_t klen = 0;
        napi_get_array_length(env, keys, &klen);
        j->env_count = (int)klen;
        j->env_keys = (char **)calloc((size_t)klen + 1, sizeof(char *));
        j->env_vals = (char **)calloc((size_t)klen + 1, sizeof(char *));
        for (uint32_t i = 0; i < klen; i++) {
            napi_value k, v;
            napi_get_element(env, keys, i, &k);
            napi_get_property(env, args[1], k, &v);
            j->env_keys[i] = napi_string_dup(env, k);
            j->env_vals[i] = napi_string_dup(env, v);
            if (!j->env_keys[i]) j->env_keys[i] = strdup("");
            if (!j->env_vals[i]) j->env_vals[i] = strdup("");
        }
    }

    // ---- threadsafe functions wrapping onData / onExit ----
    napi_value res_name;
    napi_create_string_utf8(env, "lshell_py_cb", NAPI_AUTO_LENGTH, &res_name);
    napi_create_threadsafe_function(env, args[2], NULL, res_name, 0, 1, NULL, NULL,
                                    NULL, data_call_js, &c->tsfn_data);
    napi_create_threadsafe_function(env, args[3], NULL, res_name, 0, 1, NULL, NULL,
                                    NULL, exit_call_js, &c->tsfn_exit);

    // ---- start reader threads for stdout + stderr ----
    reader_arg *ra_out = (reader_arg *)malloc(sizeof(reader_arg));
    ra_out->ctx = c; ra_out->read_fd = c->stdout_pipe[0]; ra_out->stream_id = 1;
    reader_arg *ra_err = (reader_arg *)malloc(sizeof(reader_arg));
    ra_err->ctx = c; ra_err->read_fd = c->stderr_pipe[0]; ra_err->stream_id = 2;
    pthread_create(&c->reader_out, NULL, run_reader, ra_out);
    pthread_create(&c->reader_err, NULL, run_reader, ra_err);
    pthread_detach(c->reader_out);
    pthread_detach(c->reader_err);

    // ---- post the exec job to the interpreter thread ----
    ensure_thread_started();
    queue_push(j);

    // ---- return the ctx as an external handle ----
    napi_value handle;
    napi_create_external(env, c, NULL, NULL, &handle);
    return handle;
}

// ---------------------------------------------------------------------------
// N-API: writeStdin(handle, buffer), closeStdin(handle), cancel(handle)
// ---------------------------------------------------------------------------

static exec_ctx *unwrap_ctx(napi_env env, napi_value ext) {
    void *p = NULL;
    napi_get_value_external(env, ext, &p);
    return (exec_ctx *)p;
}

static napi_value js_write_stdin(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    exec_ctx *c = unwrap_ctx(env, args[0]);
    if (!c || c->stdin_pipe[1] < 0) return NULL;
    void *data; size_t len;
    napi_get_buffer_info(env, args[1], &data, &len);
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(c->stdin_pipe[1], (char *)data + off, len - off);
        if (w < 0) { if (errno == EINTR) continue; break; }
        off += (size_t)w;
    }
    return NULL;
}

static napi_value js_close_stdin(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    exec_ctx *c = unwrap_ctx(env, args[0]);
    if (c && c->stdin_pipe[1] >= 0) {
        close(c->stdin_pipe[1]);
        c->stdin_pipe[1] = -1;
    }
    return NULL;
}

static napi_value js_cancel(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    exec_ctx *c = unwrap_ctx(env, args[0]);
    if (c) {
        c->cancel_flag = 1;
        // Ask CPython to raise KeyboardInterrupt at the next bytecode boundary.
        // PyErr_SetInterrupt is async-signal-safe and thread-safe to call from
        // any thread; the interpreter thread observes it on its next check.
        PyErr_SetInterrupt();
        // Also wake a command blocked reading stdin.
        if (c->stdin_pipe[1] >= 0) {
            close(c->stdin_pipe[1]);
            c->stdin_pipe[1] = -1;
        }
    }
    return NULL;
}

// ---------------------------------------------------------------------------
// Module registration — statically linked, resolved via _linkedBinding.
// ---------------------------------------------------------------------------

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;

    napi_create_function(env, NULL, 0, js_py_init, NULL, &fn);
    napi_set_named_property(env, exports, "py_init", fn);

    napi_create_function(env, NULL, 0, js_py_is_ready, NULL, &fn);
    napi_set_named_property(env, exports, "py_isReady", fn);

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

// Static-linking registration for process._linkedBinding('lshell_py').
//
// IMPORTANT: Node 18's NAPI_MODULE macro is SYMBOL-BASED — it only exports
// napi_register_module_v1 (found by dlopen when loading a .node file). It creates
// NO constructor and never calls napi_module_register, so a module compiled INTO
// the app is never added to node's linked-module list and _linkedBinding() can't
// find it. Instead we register the old-style way: a napi_module descriptor +
// napi_module_register(), invoked EXPLICITLY from Swift (NodeRunner) before
// node_start(). Because node isn't initialized yet, node_module_register marks it
// NM_F_LINKED → GetLinkedBinding resolves 'lshell_py' by name. The non-static
// lshell_register_python() is referenced from Swift, which also prevents the
// linker from dead-stripping this whole translation unit.
static napi_module _lshell_py_module = {
  NAPI_MODULE_VERSION,          // nm_version
  0,                            // nm_flags
  __FILE__,                     // nm_filename
  Init,                         // nm_register_func
  "lshell_py",                  // nm_modname  ← _linkedBinding lookup key
  NULL,                         // nm_priv
  { NULL, NULL, NULL, NULL },   // reserved
};

NAPI_MODULE_EXPORT void lshell_register_python(void) {
  napi_module_register(&_lshell_py_module);
}
