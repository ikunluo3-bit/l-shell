import Foundation

enum AppStrings {
    private static var prefersChinese: Bool {
        let defaultsLanguage = (UserDefaults.standard.array(forKey: "AppleLanguages") as? [String])?.first
        let language = defaultsLanguage ?? Locale.preferredLanguages.first ?? Locale.current.identifier
        return language.lowercased().hasPrefix("zh")
    }

    static func t(_ english: String, _ chinese: String) -> String {
        prefersChinese ? chinese : english
    }

    static let unableToStart = t("Unable to Start", "无法启动")
    static let ok = t("OK", "确定")
    static let appName = "L Shell"
    static let nativeContainer = t("Native Container", "原生容器")
    static let containers = t("Containers", "容器")
    static let container = t("Container", "容器")
    static let localContainers = t("Local Containers", "本地容器")
    static let createContainer = t("Create Container", "创建容器")
    static let editContainer = t("Edit Container", "编辑容器")
    static let untitledContainer = t("Untitled Container", "未命名容器")
    static let emptyContainersTitle = t("No containers yet", "还没有容器")
    static let emptyContainersMessage = t(
        "Create a local workspace container, then open a terminal or launch an AI coding tool. Official Claude users can leave config empty and sign in from the terminal; API or relay users can fill endpoint, key, and models in the container.",
        "创建一个本地工作区容器后，可以打开普通终端，也可以直接启动 AI 编程工具。官方 Claude 用户可以不填配置，进终端后登录；API 或中转站用户在容器里填写端点、密钥和模型。"
    )
    static let terminal = t("Terminal", "终端")
    static let profiles = t("Claude Configs", "Claude 配置")
    static let running = t("Running", "运行中")
    static let ready = t("Ready", "就绪")
    static let diagnostics = t("Diagnostics", "诊断")
    static let activate = t("Activate", "启用")
    static let auth = t("Auth", "认证")
    static let key = t("Key", "密钥")
    static let saved = t("Saved", "已保存")
    static let missing = t("Missing", "缺失")
    static let proxy = t("Proxy", "代理")
    static let storage = t("Storage", "存储")
    static let settings = t("Settings", "配置文件")
    static let keychain = t("Keychain", "钥匙串")
    static let localProfile = t("Local Config", "本地配置")
    static let delete = t("Delete", "删除")
    static let active = t("Active", "当前")
    static let addProfile = t("Add Container", "新增容器")
    static let profile = t("Profile", "配置")
    static let name = t("Name", "名称")
    static let workspace = t("Workspace", "工作区")
    static let endpoint = t("Endpoint", "端点")
    static let baseURL = t("Base URL", "基础 URL")
    static let mainModel = t("Main model", "主模型")
    static let opusModel = t("Opus model", "Opus 模型")
    static let fastModel = t("Fast model", "快速模型")
    static let choose = t("Choose", "选择")
    static let fetchModels = t("Fetch Models", "获取模型")
    static let fetchingModels = t("Fetching models...", "正在获取模型...")
    static func fetchedModels(_ count: Int) -> String {
        t("Fetched \(count) models", "已获取 \(count) 个模型")
    }
    static let noModelsFound = t("No models returned", "没有返回模型")
    static let authentication = t("Authentication", "认证")
    static let mode = t("Mode", "模式")
    static let apiKeyStoredLocally = t("API key is saved in the local profile and written to Claude settings.", "API 密钥会保存到本地配置，并写入 Claude 配置。")
    static let network = t("Network", "网络")
    static let saveProfile = t("Save Profile", "保存配置")
    static let saveAndActivate = t("Save and Activate", "保存并启用")
    static let aiTools = t("AI Tools", "AI 工具")
    static let claudeCode = "Claude Code"
    static let codex = "Codex"
    static let gemini = "Gemini"
    static let openCode = "OpenCode"
    static let configure = t("Configure", "配置")
    static let launch = t("Launch", "启动")
    static let available = t("Available", "可用")
    static let comingSoon = t("Coming soon", "敬请期待")
    static let disabled = t("Disabled", "不可用")
    static let endpointNotSet = t("Endpoint not set", "未设置端点")
    static let modelNotSet = t("Model not set", "未设置模型")
    static let claudeToolSubtitle = t("Configured per container", "按容器单独配置")
    static let openNormalTerminal = t("Open normal terminal", "进入普通终端")
    static let launchClaudeDefault = t("Launch Claude Code", "启动 Claude Code")
    static let launchClaudeBypassPermissions = t("Launch Claude Code with maximum permissions", "以最大权限启动 Claude Code")
    static let maxClaudePermission = t("Maximum permission mode", "最大权限模式")
    static let maxClaudePermissionHelp = t(
        "Maximum permissions: skips permission prompts. Use only in trusted containers.",
        "最高权限运行：跳过权限确认，只在信任的容器里使用。"
    )
    static let terminalLaunchTitle = t("Start Terminal", "启动终端")
    static let moreToolAdaptersComing = t("More tool adapters and refinements are coming.", "敬请期待更多工具的适配和优化。")
    static let disabledToolSubtitle = t("Adapter not included in V1", "V1 暂未接入")
    static let runtime = t("Runtime", "运行时")
    static let node = "Node"
    static let notStarted = t("Not started", "未启动")
    static let config = t("Config", "配置")
    static let activeProfile = t("Active Profile", "当前配置")
    static let home = "HOME"
    static let apiKey = t("API Key", "API 密钥")
    static let oauth = "OAuth"
    static let direct = t("Direct", "直连")
    static let customProxy = t("Custom Proxy", "自定义代理")
    static let proxyEndpoint = t("Proxy Endpoint", "代理端点")
    static let proxyNotSet = t("Proxy not set", "未设置代理")
    static let proxyEndpointPlaceholder = t("Port, host:port, or proxy URL", "端口、host:port 或代理 URL")
    static let proxyEndpointHelp = t(
        "Direct leaves proxy empty. Custom proxy accepts a port like 7890, host:port, or full http/https/socks URL.",
        "直连会留空代理。自定义代理支持端口如 7890、host:port，或完整 http/https/socks URL。"
    )
    static let sessionEndedRelaunch = t(
        "[session ended - relaunch the app to start again]",
        "[会话已结束 - 重新启动 App 后可再次开始]"
    )
    static let cancel = t("Cancel", "取消")
    static let loginMode = t("Login", "登录方式")
    static let officialLogin = t("Official", "官方登录")
    static let thirdPartyAPI = t("API / Relay", "第三方 API")
    static let officialLoginHelp = t(
        "Official Claude account: after creating, run `claude` in the terminal and sign in — no endpoint or key needed.",
        "官方 Claude 账号：创建后在终端运行 claude 按提示登录，无需端点或密钥。"
    )
    static let thirdPartyHelp = t(
        "API key or relay users: fill the endpoint, key, and models below.",
        "API 或中转站用户：在下面填写端点、密钥和模型。"
    )
    static let officialLoginStatus = t("Sign in from the terminal", "进终端运行 claude 登录")
    static let signInInTerminal = t("Official login", "官方登录")
    static let terminalSession = t("Terminal Session", "终端会话")
    static let restartSession = t("Restart session", "重启会话")
    static let sessionRestarted = t("Restarted", "已重启")
    static let restartSessionHelp = t(
        "Interrupts the running program and returns to a clean shell (same Node). Tap Open terminal to re-enter Claude.",
        "中断当前程序，回到干净的 shell（同一个 Node）。之后点「打开终端」可重新进入 Claude。"
    )
    static let restartApp = t("Restart App", "重启 App")
    static let restartAppHelp = t(
        "Quits and reopens the app — the only way to free Node or switch the container's env.",
        "退出并重开 App —— 唯一能释放 Node、切换容器环境的方式。"
    )
    static let restartAppConfirm = t("Restart the app? The current session ends.", "重启 App？当前会话会结束。")
    static let switchContainerTitle = t("Switch container?", "切换容器？")
    // %@ = running container name, %@ = target container name
    static let switchContainerConfirm = t(
        "A terminal is running in “%@”. Switching to “%@” will end it and restart the app; reopen to enter the new container.",
        "“%@” 里正在运行终端。切换到 “%@” 会终止它并重启 App；重开后自动进入新容器。"
    )
    static let switchAndRestart = t("End & switch", "终止并切换")
    static let showKeyboard = t("Keyboard", "键盘")
    static let memoryPressureWarning = t("[app] memory pressure warning", "[app] 内存压力警告")
    static let resumedAfterBackground = t(
        "[app] resumed - a stream interrupted by backgrounding will recover on retry",
        "[app] 已恢复 - 如果流式响应被后台中断，重试即可恢复"
    )

    // MARK: redesigned flow (create → home → tool → config → dashboard)
    static let create = t("Create", "创建")
    static let rename = t("Rename", "重命名")
    static let deleteContainer = t("Delete container", "删除容器")
    static let edit = t("Edit", "编辑")
    static let nameFieldPlaceholder = t("My Project", "我的项目")
    static let createContainerFooter = t(
        "Name it to create. Endpoint, key, and models are set later, per tool.",
        "起个名字就能创建。端点、密钥、模型进去后按需再填。"
    )
    static let containersListFooter = t(
        "Each container is a standalone workspace. Tap ＋ to create one, then choose AI coding or a plain terminal inside.",
        "每个容器是独立工作区。右上 ＋ 新建，点进去再选 AI 编程或纯终端。"
    )
    static let statusRunning = t("Running", "运行中")
    static let statusReady = t("Ready", "就绪")
    static let runningStripTitle = t("%@ running", "%@ 运行中")
    static let runningStripSub = t("Session is held in the background · tap to take over", "会话已挂起在后台 · 点击接管")
    static let takeover = t("Take over", "接管")

    static let aiCodingMode = t("AI coding", "AI 编程模式")
    static let aiCodingModeSub = t("Claude Code and other agentic coding tools", "Claude Code 等智能体编程工具")
    static let pureTerminal = t("Plain terminal", "纯终端")
    static let pureTerminalSub = t("Drop straight into a shell", "直接进入 shell，跑命令")
    static let homeFooter = t(
        "Both entries share one session. Whoever launches first owns it; the other shows Take over.",
        "两个入口共用同一个会话。谁先启动谁占用，另一个入口会显示「接管」。"
    )

    static let aiToolsTitle = t("AI coding tools", "AI 编程工具")
    static let claudeVendorReady = t("Anthropic · ready on device", "Anthropic · 已在本机就绪")
    static let geminiVendorSoon = t("Google · adapting", "Google · 适配中")
    static let qwenVendorSoon = t("Alibaba · adapting", "阿里 · 适配中")
    static let toolPickerFooter = t(
        "Only tools that run offline on device (pure JS / Node) are listed. Codex, OpenCode, Kimi, and ZCode can't run in this runtime, so they're not shown.",
        "列表只收录能在本机离线跑起来的工具（纯 JS / Node）。Codex、OpenCode、Kimi、ZCode 因原生二进制或 Python 无法在此运行时落地，已不列出。"
    )

    static let configTitle = t("Configure Claude Code", "配置 Claude Code")
    static let claudeCliSubtitle = t("Anthropic official CLI", "Anthropic 官方 CLI")
    static let connectionSection = t("Connection", "连接方式")
    static let noKeyTitle = t("No key needed", "无需密钥")
    static let noKeySub = t("Run `claude` in the terminal and sign in", "进终端运行 claude 按提示登录")
    static let endpointKeySection = t("Endpoint and key", "端点与密钥")
    static let modelSection = t("Models", "模型")
    static let saveAndEnter = t("Save and continue", "保存并进入")

    static let currentConfigSection = t("Current config", "当前配置")
    static let dashboardFooter = t(
        "Tap Edit to change the connection. Once launched, you can restart the session below.",
        "改配置点右上「编辑」回到配置页。启动后可在下方随时重启会话。"
    )
    static let openTerminal = t("Open terminal", "打开终端")
    static let choosePermission = t("Choose a permission mode", "选择权限模式后打开终端")
    static let permDefault = t("Default permissions", "默认权限")
    static let permMax = t("Maximum permissions", "最大权限")
}
