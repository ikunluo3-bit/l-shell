<div align="center">

<img src="docs/banner.svg" alt="L SHELL" width="440">

[English](README.md) · **简体中文**

一个**完全在 iOS 设备本地运行**的开发终端——**首个把 Claude Code 跑进设备**的实现,同时是一套完整的开发环境:git、npm、Python、SSH 和一个 AI CLI,全部在同一个进程内。

[![在线能力总览](https://img.shields.io/badge/%E2%96%B6%20%E5%9C%A8%E7%BA%BF%E8%83%BD%E5%8A%9B%E6%80%BB%E8%A7%88-f0a848?style=for-the-badge)](https://ikunluo3-bit.github.io/l-shell/)

**一个主题化的交互式展示**——页面内嵌活的终端、完整命令清单和架构。<sub>(源文件在 [`docs/`](docs/))</sub>

<br>

![platform](https://img.shields.io/badge/platform-iOS%2018%2B-000000?style=flat-square)
![runtime](https://img.shields.io/badge/Node-18.19.1-3c873a?style=flat-square)
![python](https://img.shields.io/badge/CPython-3.13-4b8bbe?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-b06f22?style=flat-square)
![status](https://img.shields.io/badge/%E9%A6%96%E4%B8%AA%E8%AE%BE%E5%A4%87%E7%AB%AF-Claude%20Code-f0a848?style=flat-square)

</div>

---

L Shell 把真实的语言运行时**以 ARM64 机器码在进程内嵌入**——V8、CPython、OpenSSL——跑在 [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)(jitless V8)里。零模拟、零 WebAssembly、无远程 shell、无需越狱。官方 Claude Code CLI 未经改动在同一进程内运行,它的 Bash 工具直接调用同样在设备上的 ~90 个 coreutils、git/npm/pip 和整套 SSH。

## 目录

- [为什么是 L Shell](#为什么是-l-shell)
- [能力](#能力)
- [架构](#架构)
- [安装](#安装)
- [从源码构建](#从源码构建)
- [仓库结构](#仓库结构)
- [边界](#边界)
- [路线图](#路线图)
- [安全与隐私](#安全与隐私)
- [参与贡献](#参与贡献)
- [许可](#许可)
- [致谢](#致谢)

## 为什么是 L Shell

两点值得一看。

**1. 首个设备端 Claude Code。** 其它"手机上的 Claude Code"都是连到服务器的远程壳。L Shell 把真正的 CLI 跑在设备上——可离线,文件留在本地。

**2. 一套完整的原生开发环境。** 不是玩具 shell:真正的 `git`(24 个子命令)、`npm`、`python3`(嵌入式 CPython)、`pip`、整套 SSH,以及 ~90 个 coreutils——就是 AI 的 Bash 工具所调用的那批工具。

在 iOS 的约束下,每个终端项目都选了自己的路线。L Shell 选择原生运行时进程内嵌入——如实对比如下:

| 路线 | 代表 | 优势 | 取舍 |
| --- | --- | --- | --- |
| **原生 · 进程内** | **L Shell** | 真实的 Node / Python 生态;AI CLI 在设备内运行;完全离线可用 | 无法运行外部二进制;JS 无 JIT |
| x86 用户态模拟 | iSH | 完整 Alpine / apk 生态,最接近真实 Linux 的语义 | 逐条指令翻译带来速度开销 |
| WASM + 原生端口 | a-Shell | 成熟稳定,系统集成深(快捷指令 / 文件),自带 TeX 等重型工具 | 没有 Node / npm 生态 |
| 纯远程客户端 | Blink · Termius | 远程体验的标杆(mosh、多设备漫游) | 设备本身不运行代码 |

> 基于各项目公开文档。四条路线服务不同用途,并无高下。L Shell 选原生路线,是为了让 AI CLI 与真实生态在设备内运行。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 能力

| 领域 | 内容 |
| --- | --- |
| **运行时** | `node`(Node 18.19.1)· `git`(isomorphic-git,24 个子命令,HTTPS + token)· `npm`(进程内安装器)· `python3`(CPython 3.13.14,153 个标准库 + 68 个 C 扩展)· `pip3`(纯 Python wheel) |
| **SSH 套件** | `ssh` · `sshpass` · `ssh-keygen` · `ssh-copy-id` · `scp` · `sftp`——一次性命令、活的交互式远程终端(vim / top / tmux)、密钥与密码认证、2FA、`~/.ssh/config`、ProxyJump |
| **~90 个 coreutils** | `grep rg sed awk jq yq curl wget tar find sort …`,由 [just-bash](https://www.npmjs.com/package/just-bash) + 设备补齐提供 |
| **AI CLI** | `claude`(官方 Claude Code,未改动)· Gemini CLI 与 iFlow 已实测可运行(不预装) |

**[→ 完整交互式展示](https://ikunluo3-bit.github.io/l-shell/)**——页面内嵌活的终端、完整命令清单和架构,一个主题化的能力总览站。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 架构

```
┌─ iOS App (SwiftUI + SwiftTerm) ──────────────────────────────┐
│  终端模拟器  ── 字节 ⇅ ──  NodeRunner (pipes + dup2)          │
│                                                               │
│  nodejs-mobile · V8 (Node 18.19.1, jitless)      [ARM64]      │
│    ├─ just-bash · ~90 coreutils                  [纯 JS]     │
│    ├─ isomorphic-git · npm · ssh2                [纯 JS]     │
│    ├─ N-API 桥 → CPython 3.13 (68 个 .so)        [ARM64]      │
│    └─ node:crypto → OpenSSL 3                     [ARM64]      │
│                                                               │
│  Claude Code 2.1.112 (未改动) ── Bash 工具 ──▶ 上面这些       │
│  HOME / 工作区 → App Documents(Files.app 可见)              │
└───────────────────────────────────────────────────────────────┘
```

三条 iOS 硬约束,以及 L Shell 各自的对策:

1. **禁止 `fork`/`exec`**(跑不了外部二进制)→ `preload/shims/child_process.js` 拦截每一次 `node:child_process` 调用,路由到进程内实现(`bash`→just-bash、`git`→isomorphic-git、`ssh`→ssh2……)。
2. **jitless V8——无 JIT,因而也没有 WebAssembly** → `fetch` 用 `node:https` 重写(绕开 undici/llhttp.wasm);所有依赖要么纯 JS 要么原生;ssh2 的 poly1305 WASM 换成纯 JS stub。
3. **单一 Node 实例,无法进程内重启** → `process.exit` 改成可捕获的 `SessionExit`;切换容器时重启 App 以保证隔离。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 安装

每个 [**Release**](../../releases/latest) 都附带一个预编译的 **`LShell.ipa`**。它是**开发签名(development-signed)**的,所以在未加入其描述文件的设备上不能直接安装。两条诚实的路:

**方式一 —— 侧载 IPA。** 从 Releases 页下载 `LShell.ipa`,用 [AltStore](https://altstore.io) 或 [Sideloadly](https://sideloadly.io) 这类侧载工具,拿你自己的 Apple ID 重签。免费 Apple ID 可用(App 每 7 天需重签);付费开发者账号则无此限制。

**方式二 —— [从源码构建](#从源码构建)**,在 Xcode 里用你自己的签名团队。

**首次启动。** 启动后用你的 Claude 账号登录,或配置第三方 Anthropic 兼容的 API 端点 + key。若网络需要,设置 HTTPS 代理。工作区在 App 的 Documents 目录(Files.app 可见)。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 从源码构建

本仓库**只含源代码**。大的预编译二进制和第三方代码需另行获取(见 [`.gitignore`](.gitignore))。需要 macOS + Xcode。

```bash
# 0. 工具
brew install xcodegen

# 1. JS 依赖 + vendored Claude Code (2.1.112)
cd node-runtime && npm install
npm pack @anthropic-ai/claude-code@2.1.112
mkdir -p vendor/claude-code && tar -xzf anthropic-ai-claude-code-2.1.112.tgz -C vendor/claude-code --strip-components=1
cd ..

# 2. 预编译框架 → ios/Frameworks/（体积大，从上游获取）
#    • NodeMobile.xcframework —— Node 18.19.1 iOS 版（small-icu）：
#        https://github.com/1Conan/nodejs-mobile
#    • Python.xcframework —— BeeWare Python-Apple-support 3.13：
#        https://github.com/beeware/Python-Apple-support/releases
#    （为设备构建只需 ios-arm64 切片）

# 3. 打包运行时 + Python，生成 Xcode 工程
cd ios
bash scripts/bundle-runtime.sh
bash scripts/bundle-python.sh
xcodegen generate

# 4. 打开、选你的签名团队、连真机运行
open ClaudeTerminal.xcodeproj
```

两个构建配置可在设备上并存:**Debug** = `L Shell Dev`(`…claudeterminal.dev`),**Release** = `L Shell`(`…claudeterminal`)。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 仓库结构

```
ios/                         iOS App（SwiftUI + SwiftTerm）
  ClaudeTerminal/*.swift       App、终端视图、NodeRunner、设置、CPython 桥
  scripts/*.sh                 bundle-runtime / bundle-python / 构建装机
  project.yml                  XcodeGen 配置（Debug=开发版，Release=正式版）
node-runtime/                打包进 App 的 JS 运行时
  bootstrap.js                 NodeRunner node_start 的入口
  shell.js                     交互式 shell（提示符、启动 claude/ssh）
  preload/shims/*.js           child_process / fetch / tty / wasm / control 等 shim
  preload/commands/*.js        git · npm · python · pip · ssh 套件 · coreutils · curl
docs/                        能力网站（GitHub Pages）
native-bridge-poc/           原生 spawn 桥的概念验证（路线图）
test/                        回归测试
```

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 边界

诚实的平台边界——是 iOS 约束,不是 bug。以下命令会返回清晰的说明,而不是模拟的成功:

```
npx  bun  deno  ruby  perl  php  go  rustc  cargo  java  gcc  cc  make
```

iOS 禁止 `fork`/`exec`(跑不了外部二进制),jitless 运行时也没有 WebAssembly——上面这些二者必需其一。文件可以创建和编辑,只是不能运行。

其它已知项:Node 18 已 EOL(计划自维护 Node 22 fork);不支持 MCP stdio server(单 Node 实例);每开一个 Claude 新会话会泄漏一份 `cli.js` 模块(数十次后重启 App);真机构建需要 Xcode 签名。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 路线图

状态如实标注;不承诺时间线。

- **`[已验证]`** 更多 AI CLI —— Gemini CLI / iFlow 已在真机跑通。
- **`[原型]`** 原生 spawn 桥 + 原生 `grep`/`cat` 系 —— 已在 [`native-bridge-poc/`](native-bridge-poc/) 验证。
- **`[计划]`** CRuby 原生端口 —— 复用 CPython 的嵌入模式。
- **`[研究]`** 用户态 PTY —— 以 iSH 的 tty 实现为蓝本。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 安全与隐私

- **API 凭据**存放在 iOS **Keychain**,不随备份明文外泄。
- **会话记录**(`.claude/`)在 App 的 Documents 目录——会进入 iCloud / 电脑备份,且 Files.app 可见。
- **请使用官方 Anthropic API 或忠实转发的端点。** 反代其它厂商的 API 中转站可能往你的对话里注入指令、或读取你的对话。优先用官方端点,避免不可信的中转。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 参与贡献

欢迎 Issue 与 PR。适合上手的地方:`node-runtime/preload/commands/` 里的命令实现、`node-runtime/preload/shims/` 里对 iOS 约束的处理、以及 `native-bridge-poc/` 里的原生桥。改动请保持纯 JS / jitless 安全(不用 WebAssembly、不用 `fork`/`exec`),并与周围风格一致。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 许可

以 [MIT License](LICENSE) 发布。

内附的 **Claude Code**(锁定 2.1.112,位于 `node-runtime/vendor/`,构建时获取)是 Anthropic 自有软件,遵循 Anthropic 自己的许可与条款——不在本项目许可范围内。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>

## 致谢

基于以下项目构建:[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) · [CPython / BeeWare Python-Apple-support](https://github.com/beeware/Python-Apple-support) · [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) · [just-bash](https://www.npmjs.com/package/just-bash) · [ssh2](https://github.com/mscdex/ssh2) · [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) · 以及 Anthropic 的 [Claude Code](https://github.com/anthropics/claude-code)。

<div align="right"><a href="#目录">↑ 返回顶部</a></div>
