# native-bridge PoC — Node child_process → 进程内原生命令（流式）

**目的**：攻下拓扑 A 最大风险点——同进程里，Node 的 `child_process.spawn()` 能否真 spawn 一个 ios_system 式的原生命令、并**流式**拿回输出，且不与 Node/libuv 的真实 fd 打架。研究结论说"至今无人在同进程内做成"，这个 PoC 先证伪它。

## 结论：✅ 成立

在 **Node 18.20.4 `--jitless`（x86_64）** 和 **原生 arm64 node `--jitless`（iOS 实际架构）** 上，20 项断言全绿：

| 验证点 | 结果 |
|---|---|
| **流式非批处理** | democount 每 80ms 一个 tick，`child.stdout` 逐个 'data' 事件、跨 260ms 到达（不是跑完一次性 dump） |
| **与 libuv 的 fd 隔离** | 命令用 `__thread thread_stdout`（ios_system 模型）写自己的 pipe，**从不泄漏到 Node 的真 fd 1**（子进程捕获真 fd1 严格验证） |
| **并发无串扰** | 两条命令同时跑，各自 stdout 干净、互不混入 |
| **stdin 投递** | `child.stdin.write()` 到达原生命令并回显 |
| **退出码** | demofail → `child` 'exit' code 3；stderr 正确路由 |
| **协作式中断** | demospin → `child.kill()` → 一个 tick 内停止（code 130） |
| **真 spawn() 接口** | AI CLI 调用的 `child_process.spawn(name,args)` 经流式适配器直接驱动原生命令 |
| **负向对照** | demoleak 用真 `printf`（未移植）→ 泄漏到 fd1，**证明命令必须重编译成 thread_stdout 模型** |

## 机制（与 nodejs-mobile iOS 完全同构）

```
spawn('git')  ← AI CLI
  → 流式 ChildProcess 适配器（stdout/stderr Readable, stdin Writable）
  → N-API dispatch(name, argv, onData, onExit)          [native_bridge.c]
  → pthread 跑 command_main(argc,argv)，其 stdio = __thread FILE*（ios_system 模型）
  → 命令写 thread_stdout（自己的 pipe），绝不碰真 fd 1
  → reader 线程 drain pipe → napi_threadsafe_function 跨线程回 Node（不碰 V8）
  → onData 逐块 push 到 child.stdout；EOF 后 join 命令线程取退出码 → onExit
```

## 里程碑 2：接真 ios_system 核心集 ✅

在机制验证之上，进一步跑通了**真实的 BSD coreutils/grep**（源码未改，取自 ios_system 树）：

| 命令 | 来源 | 验证 |
|---|---|---|
| **cat** | `text_cmds/cat/cat.c` 原样 | 输出与 `/bin/cat` **逐字节一致**（含 `-n`、stdin、缺文件错误路径） |
| **wc** | `text_cmds/wc/wc.c` 原样 | 计数与 `/usr/bin/wc` 一致（含 `-l`） |
| **grep** | `text_cmds/grep/{grep,util,file,queue}.c` 原样 | 11 种 flag/正则（`-n/-i/-c/-v/-w/-o/-E`、锚点、退出码）与 `/usr/bin/grep` **逐字节一致** |

做法：`ios-cmds/ios_runtime.c` 是**最小忠实的 ios_system 运行时**——只实现命令经 `ios_error.h` 重定向到的那些 `ios_*` 符号（thread_stdout 系列 + `ios_exit`→pthread_exit + `ios_write/ios_fputc/...`），外加 `err/warn/getprogname` 覆盖让错误输出也隔离、progname 正确。命令用 `pthread_cleanup` 收尾，无论 `return` 还是 `exit()`→pthread_exit 都能关 thread_stdout（reader 见 EOF）并回收退出码。**不引入 4100 行的 ios_system.m + Foundation。**

## 运行

```bash
bash build.sh                 # clang 编通用二进制 (arm64+x86_64)：bridge + ios_runtime + 真 cat/wc/grep
node run-test.mjs             # 机制：20 项证明（含子进程 fd 隔离），18.20.4 --jitless
NODE18 --jitless spawn-demo.mjs     # spawn() 端到端
NODE18 --jitless real-cmds-test.mjs # 真 cat/wc vs 系统二进制逐字节对比
NODE18 --jitless grep-test.mjs      # 真 grep vs /usr/bin/grep 11 组对比
# (NODE18=/path/to/node-v18-darwin/bin/node；arm64 用 `arch -arm64 node --jitless ...`)
```

## 保真边界（诚实声明）

**这个 PoC 证明的是机制，机制在 iOS 上同构**——N-API 是 ABI 稳定的、libuv 在 macOS/iOS 都用 kqueue、pthread/`__thread`/pipe 全是标准 POSIX、`--jitless` 只禁 WASM 不影响 N-API/多线程（研究已确认）。所以 macOS 是此风险点的高保真代理。

**尚未在本 PoC 覆盖（后续步骤，均有先例）**：
1. 把 addon 按 nodejs-mobile 方式打成随 App 签名的 `.framework` + `dlopen` 重定向（nodejs-mobile-react-native 的既有构建流程）。
2. 接**真** ios_system：demo 命令用的是与 ios_system 相同的 `thread_stdout` 模型，但真 `ios_system(cmd)` 有自己的 session/pipe 装配要适配（`ios_setStreams`/`ios_switchSession`）。
3. iOS 沙箱运行时（本机无沙箱）——但桥不碰任何受限 API（pipe/pthread/N-API 全部允许）。

**真命令层的诚实边界**：
- **grep 关掉了 fastmatch 优化器**（`-DWITHOUT_FASTMATCH`），走 libc `regcomp/regexec`——仍是**真 grep 逻辑**（正则/flag/退出码全对），只是少了字面量快匹配的性能优化。生产版可补回 fastmatch。
- **真 `ios_system.m` 有更全的装配**（session 管理、`ios_popen` 管道跨线程传 FILE*、`ios_dup2` 完整 fd 重映射、`commandDictionary.plist` 派发 140+ 命令）；这里的 `ios_runtime.c` 是够 cat/wc/grep 跑的**最小子集**，接更多命令时按需补 `ios_*`。
- **BSD getopt 全局量（optind/optarg）是进程共享的**——并发跑两个吃参数的命令会竞争。真 ios_system 也有此限制；生产版每命令应存/复位 getopt 状态。

**已知生产 TODO**：
- handle 目前是裸 external 指针，命令退出后被 reader 线程释放；生产版需改成 id+注册表+generation 的存活安全句柄，防止 JS 在退出后 cancel/write 造成 use-after-free。
- 中断是协作式（flag + 关 stdin 唤醒阻塞读），符合研究结论；**纯 CPU 死循环且无检查点的命令仍无法强杀**（平台硬边界）。
- stderr 目前并入 stdout；生产版分开两个 pipe。
