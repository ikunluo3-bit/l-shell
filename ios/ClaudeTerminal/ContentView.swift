import SwiftUI

// MARK: - Navigation

/// Every screen in the container flow. Navigation is fully path-driven so the multi-step
/// flow (home → tool → config → dashboard → terminal) is explicit and reorderable.
enum Route: Hashable {
    case home(String)            // containerID
    case toolPicker(String)
    case claudeConfig(String)
    case claudeDashboard(String)
    case terminal(ClaudeLaunchConfig)
    case diagnostics
}

/// Owns the navigation path and surfaces launch errors. Injected as an environment
/// object so any screen can push/replace routes without threading bindings everywhere.
final class FlowRouter: ObservableObject {
    @Published var path: [Route] = []
    @Published var errorMessage: String?
}

// MARK: - Root

/// Root screen for the native L Shell container manager. Node is not started on app
/// launch; a container and a launch mode are chosen before the terminal boots. The
/// management UI follows the system appearance; only the terminal surface stays dark.
struct ContentView: View {
    @StateObject private var store = ClaudeProfileStore()
    @StateObject private var router = FlowRouter()

    private var resourceRoot: String { Bundle.main.path(forResource: "nodejs", ofType: nil) ?? "" }

    var body: some View {
        NavigationStack(path: $router.path) {
            ContainersListView(store: store)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .home(let id):
                        ContainerHomeView(store: store, containerID: id, resourceRoot: resourceRoot)
                    case .toolPicker(let id):
                        AIToolPickerView(store: store, containerID: id)
                    case .claudeConfig(let id):
                        ClaudeConfigView(store: store, containerID: id)
                    case .claudeDashboard(let id):
                        ClaudeDashboardView(store: store, containerID: id, resourceRoot: resourceRoot)
                    case .terminal(let config):
                        TerminalScreen(resourceRoot: resourceRoot, launchConfig: config)
                    case .diagnostics:
                        DiagnosticsView(store: store)
                    }
                }
        }
        .tint(Brand.coral)
        .environmentObject(router)
        .onAppear {
            store.bootstrap()
            resumePendingSwitch()
            applyDebugRoute()
        }
        .alert(AppStrings.unableToStart, isPresented: Binding(
            get: { router.errorMessage != nil },
            set: { if !$0 { router.errorMessage = nil } }
        )) {
            Button(AppStrings.ok, role: .cancel) { router.errorMessage = nil }
        } message: {
            Text(router.errorMessage ?? "")
        }
    }

    /// After a container-switch restart, resume straight into the target container's
    /// terminal — a brand-new process, so container isolation is guaranteed. No-op
    /// (fast path) when there is no pending switch.
    private func resumePendingSwitch() {
        guard let pending = PendingContainerSwitch.take() else { return }
        // Target container deleted while the app was down → nothing to resume (not an error).
        guard let profile = store.profile(id: pending.containerID) else { return }
        do {
            let cfg = try store.makeLaunchConfig(for: profile, launchMode: pending.mode)
            store.setActive(pending.containerID)
            router.path = [.home(pending.containerID), .terminal(cfg)]
        } catch {
            // Surface the failure instead of silently losing the requested switch.
            router.errorMessage = error.localizedDescription
        }
    }

    /// Dev-only: jump straight to a screen at launch for screenshot verification.
    /// Set SIMCTL_CHILD_LSHELL_DEBUG_ROUTE=home|tool|config|dashboard. No-op otherwise.
    private func applyDebugRoute() {
        guard let raw = ProcessInfo.processInfo.environment["LSHELL_DEBUG_ROUTE"],
              let id = store.profiles.first?.id else { return }
        switch raw {
        case "home":      router.path = [.home(id)]
        case "tool":      router.path = [.home(id), .toolPicker(id)]
        case "config":    router.path = [.home(id), .toolPicker(id), .claudeConfig(id)]
        case "dashboard": router.path = [.home(id), .claudeDashboard(id)]
        case "claude":    // auto-launch claude for runtime debugging
            if let profile = store.profile(id: id),
               let cfg = try? store.makeLaunchConfig(for: profile, launchMode: .claudeDefault) {
                router.path = [.home(id), .terminal(cfg)]
            }
        case "nodetest":  // auto-run the in-process node self-test at boot
            if let profile = store.profile(id: id),
               let cfg = try? store.makeLaunchConfig(for: profile, launchMode: .debugNodeTest) {
                router.path = [.home(id), .terminal(cfg)]
            }
        default:          break
        }
    }
}

// MARK: - 1 · Containers list

private struct ContainersListView: View {
    @ObservedObject var store: ClaudeProfileStore
    @EnvironmentObject private var router: FlowRouter
    @ObservedObject private var session = TerminalSession.shared

    @State private var showingCreate = false
    @State private var renameTarget: ClaudeProfile?
    @State private var renameText = ""

    var body: some View {
        Group {
            if store.profiles.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .navigationTitle(AppStrings.containers)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingCreate = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel(AppStrings.createContainer)
            }
        }
        .sheet(isPresented: $showingCreate) {
            CreateContainerSheet { name in
                var profile = ClaudeProfile.newProfile()
                profile.name = name
                store.save(profile: profile)
                showingCreate = false
                router.path.append(.home(profile.id))
            }
        }
        .alert(AppStrings.rename, isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField(AppStrings.nameFieldPlaceholder, text: $renameText)
            Button(AppStrings.ok) {
                if var p = renameTarget {
                    p.name = renameText
                    store.save(profile: p)
                }
                renameTarget = nil
            }
            Button(AppStrings.cancel, role: .cancel) { renameTarget = nil }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(AppStrings.emptyContainersTitle, systemImage: "shippingbox")
        } description: {
            Text(AppStrings.emptyContainersMessage)
        } actions: {
            Button { showingCreate = true } label: {
                Label(AppStrings.createContainer, systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.coral)
        }
    }

    private var list: some View {
        List {
            Section {
                ForEach(store.profiles) { profile in
                    NavigationLink(value: Route.home(profile.id)) {
                        row(profile)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { store.delete(profile.id) } label: {
                            Label(AppStrings.delete, systemImage: "trash")
                        }
                    }
                    .contextMenu {
                        Button {
                            renameText = profile.name
                            renameTarget = profile
                        } label: { Label(AppStrings.rename, systemImage: "pencil") }
                        Button(role: .destructive) { store.delete(profile.id) } label: {
                            Label(AppStrings.delete, systemImage: "trash")
                        }
                    }
                }
            } footer: {
                Text(AppStrings.containersListFooter)
            }
        }
        .listStyle(.insetGrouped)
    }

    private func row(_ profile: ClaudeProfile) -> some View {
        let isRunning = session.runningContainerID == profile.id
        return HStack(spacing: 13) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(hex: 0x8C8477))
                .frame(width: 30, height: 30)
                .overlay(Image(systemName: "shippingbox.fill").font(.system(size: 14)).foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.displayName).font(.headline).lineLimit(1)
                Text(subtitle(profile, isRunning: isRunning))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if isRunning { StatusPill(text: AppStrings.statusRunning, running: true) }
        }
        .padding(.vertical, 4)
    }

    private func subtitle(_ profile: ClaudeProfile, isRunning: Bool) -> String {
        if isRunning { return String(format: AppStrings.runningStripTitle, AppStrings.claudeCode) }
        return profile.loginMode == .official ? AppStrings.officialLogin : AppStrings.thirdPartyAPI
    }
}

private struct CreateContainerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    let onCreate: (String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(AppStrings.nameFieldPlaceholder, text: $name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .onSubmit(create)
                } header: {
                    Text(AppStrings.name)
                } footer: {
                    Text(AppStrings.createContainerFooter)
                }
            }
            .navigationTitle(AppStrings.createContainer)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(AppStrings.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(AppStrings.create, action: create)
                        .fontWeight(.semibold)
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.height(220)])
    }

    private func create() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onCreate(trimmed)
    }
}

// MARK: - 2 · Container home

private struct ContainerHomeView: View {
    @ObservedObject var store: ClaudeProfileStore
    let containerID: String
    let resourceRoot: String
    @EnvironmentObject private var router: FlowRouter
    @ObservedObject private var session = TerminalSession.shared

    @State private var renaming = false
    @State private var renameText = ""
    @State private var showSwitchConfirm = false

    private var container: ClaudeProfile { store.profile(id: containerID) ?? .newProfile() }
    private var isRunning: Bool { session.runningContainerID == containerID }

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if isRunning {
                    RunningStrip(toolName: AppStrings.claudeCode) {
                        if let cfg = session.currentConfig { router.path.append(.terminal(cfg)) }
                    }
                }
                EntryCard(systemIcon: "sparkles",
                          title: AppStrings.aiCodingMode,
                          subtitle: AppStrings.aiCodingModeSub,
                          accent: true) {
                    router.path.append(.toolPicker(containerID))
                }
                EntryCard(systemIcon: "terminal",
                          title: AppStrings.pureTerminal,
                          subtitle: AppStrings.pureTerminalSub) {
                    openShell()
                }
                Text(AppStrings.homeFooter)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(container.displayName)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { renameText = container.name; renaming = true } label: {
                        Label(AppStrings.rename, systemImage: "pencil")
                    }
                    NavigationLink(value: Route.diagnostics) {
                        Label(AppStrings.diagnostics, systemImage: "waveform.path.ecg")
                    }
                    Button(role: .destructive) {
                        store.delete(containerID)
                        router.path.removeAll()
                    } label: { Label(AppStrings.deleteContainer, systemImage: "trash") }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .alert(AppStrings.rename, isPresented: $renaming) {
            TextField(AppStrings.nameFieldPlaceholder, text: $renameText)
            Button(AppStrings.ok) {
                var p = container
                p.name = renameText
                store.save(profile: p)
            }
            Button(AppStrings.cancel, role: .cancel) {}
        }
        .confirmationDialog(AppStrings.switchContainerTitle,
                            isPresented: $showSwitchConfirm,
                            titleVisibility: .visible) {
            Button(AppStrings.switchAndRestart, role: .destructive) {
                PendingContainerSwitch.stashAndRestart(containerID: containerID, mode: .shell)
            }
            Button(AppStrings.cancel, role: .cancel) {}
        } message: {
            Text(String(format: AppStrings.switchContainerConfirm,
                        session.runningContainerName ?? "", container.displayName))
        }
    }

    private func openShell() {
        // A different container is live → confirm, then full-restart into this one.
        if session.conflicts(with: containerID) { showSwitchConfirm = true; return }
        do {
            store.setActive(containerID)
            // Session already up for THIS container → take it over as-is (can't spawn a
            // 2nd Node); otherwise boot a plain shell.
            if session.isRunning {
                if let cfg = session.currentConfig { router.path.append(.terminal(cfg)) }
            } else {
                let cfg = try store.makeLaunchConfig(for: container, launchMode: .shell)
                router.path.append(.terminal(cfg))
            }
        } catch {
            router.errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 3 · AI tool picker

private struct AIToolPickerView: View {
    @ObservedObject var store: ClaudeProfileStore
    let containerID: String
    @EnvironmentObject private var router: FlowRouter

    private var available: [AITool] { AITool.allCases.filter { $0.isAvailable } }
    private var soon: [AITool] { AITool.allCases.filter { !$0.isAvailable } }

    var body: some View {
        List {
            Section {
                ForEach(available) { tool in
                    Button { openClaude() } label: {
                        toolRow(tool, dimmed: false, trailing: {
                            AnyView(Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary))
                        })
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text(AppStrings.available)
            }

            Section {
                ForEach(soon) { tool in
                    toolRow(tool, dimmed: true, trailing: {
                        AnyView(Text(AppStrings.comingSoon)
                            .font(.caption).fontWeight(.semibold)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 9).padding(.vertical, 3)
                            .background(Color(.tertiarySystemFill), in: Capsule()))
                    })
                }
            } header: {
                Text(AppStrings.comingSoon)
            } footer: {
                Text(AppStrings.toolPickerFooter)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(AppStrings.aiToolsTitle)
        .navigationBarTitleDisplayMode(.large)
    }

    /// First visit → config gate; once configured → straight to the dashboard.
    private func openClaude() {
        let configured = store.profile(id: containerID)?.isClaudeConfigured ?? false
        router.path.append(configured ? .claudeDashboard(containerID) : .claudeConfig(containerID))
    }

    private func toolRow(_ tool: AITool, dimmed: Bool, trailing: () -> AnyView) -> some View {
        HStack(spacing: 13) {
            MonogramTile(text: tool.monogram, background: tool.tileBackground, dimmed: dimmed)
            VStack(alignment: .leading, spacing: 2) {
                Text(tool.displayName).font(.headline)
                    .foregroundStyle(dimmed ? .secondary : .primary)
                Text(tool.vendorLine).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

// MARK: - 4 · Claude config (independent page)

private struct ClaudeConfigView: View {
    @ObservedObject var store: ClaudeProfileStore
    let containerID: String
    @EnvironmentObject private var router: FlowRouter

    @State private var draft: ClaudeProfile
    @State private var modelOptions: [String] = []
    @State private var modelFetchMessage: String?
    @State private var isFetchingModels = false

    init(store: ClaudeProfileStore, containerID: String) {
        self.store = store
        self.containerID = containerID
        _draft = State(initialValue: store.profile(id: containerID) ?? ClaudeProfile.newProfile())
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    MonogramTile(text: "C", background: AnyShapeStyle(Brand.coral), size: 38)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(AppStrings.claudeCode).font(.headline)
                        Text(AppStrings.claudeCliSubtitle).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(.vertical, 2)
            }
            .listRowBackground(Color.clear)

            Section {
                Picker(AppStrings.connectionSection, selection: $draft.loginMode.animation()) {
                    ForEach(ClaudeLoginMode.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            } header: {
                Text(AppStrings.connectionSection)
            }

            if draft.loginMode == .official {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(AppStrings.noKeyTitle).font(.body)
                            Text(AppStrings.noKeySub).font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "lock.open").foregroundStyle(.secondary)
                    }
                } footer: {
                    Text(AppStrings.officialLoginHelp)
                }
            } else {
                Section(AppStrings.endpointKeySection) {
                    TextField(AppStrings.baseURL, text: $draft.baseURL)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker(AppStrings.mode, selection: $draft.authMode) {
                        ForEach(ClaudeAuthMode.allCases) { Text($0.title).tag($0) }
                    }
                    SecureField(draft.authMode.placeholder, text: $draft.credential)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }

                Section {
                    Button { fetchModels() } label: {
                        Label(AppStrings.fetchModels, systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(isFetchingModels)
                    if let modelFetchMessage {
                        Text(modelFetchMessage).font(.caption).foregroundStyle(.secondary)
                    }
                    ModelField(title: AppStrings.mainModel, value: $draft.mainModel, options: modelOptions)
                    ModelField(title: AppStrings.opusModel, value: $draft.opusModel, options: modelOptions)
                    ModelField(title: AppStrings.fastModel, value: $draft.fastModel, options: modelOptions)
                } header: {
                    Text(AppStrings.modelSection)
                } footer: {
                    Text(AppStrings.thirdPartyHelp)
                }
            }

            Section(AppStrings.network) {
                Picker(AppStrings.proxy, selection: $draft.proxyMode) {
                    ForEach(ClaudeProxyMode.allCases) { Text($0.title).tag($0) }
                }
                if draft.proxyMode == .custom {
                    TextField(AppStrings.proxyEndpointPlaceholder, text: $draft.proxyEndpoint)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
        }
        .navigationTitle(AppStrings.configTitle)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button(action: saveAndEnter) {
                Text(AppStrings.saveAndEnter)
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.coral)
            .controlSize(.large)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    private func saveAndEnter() {
        draft.claudeConfigured = true   // mark configured so later visits skip this gate
        store.save(profile: draft.normalized())
        Haptics.success()
        guard let idx = router.path.lastIndex(of: .claudeConfig(containerID)) else {
            router.path.append(.claudeDashboard(containerID)); return
        }
        if idx > 0, router.path[idx - 1] == .claudeDashboard(containerID) {
            router.path.removeSubrange(idx...)          // came from "编辑": pop back to dashboard
        } else {
            router.path[idx] = .claudeDashboard(containerID)   // forward flow: replace config with dashboard
        }
    }

    private func fetchModels() {
        isFetchingModels = true
        modelFetchMessage = AppStrings.fetchingModels
        let profile = draft.normalized()
        Task {
            do {
                let models = try await ClaudeModelService.fetchModels(baseURL: profile.baseURL,
                                                                      credential: profile.credential,
                                                                      authMode: profile.authMode)
                await MainActor.run {
                    modelOptions = models
                    modelFetchMessage = models.isEmpty ? AppStrings.noModelsFound : AppStrings.fetchedModels(models.count)
                    isFetchingModels = false
                }
            } catch {
                await MainActor.run {
                    modelFetchMessage = error.localizedDescription
                    isFetchingModels = false
                }
            }
        }
    }
}

private struct ModelField: View {
    let title: String
    @Binding var value: String
    let options: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            HStack {
                TextField(title, text: $value)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                if !options.isEmpty {
                    Menu {
                        ForEach(options, id: \.self) { model in
                            Button(model) { value = model }
                        }
                    } label: {
                        Label(AppStrings.choose, systemImage: "chevron.down")
                    }
                }
            }
        }
    }
}

// MARK: - 5 · Claude dashboard

private struct ClaudeDashboardView: View {
    @ObservedObject var store: ClaudeProfileStore
    let containerID: String
    let resourceRoot: String
    @EnvironmentObject private var router: FlowRouter
    @ObservedObject private var session = TerminalSession.shared

    @State private var showingRestartAppConfirm = false
    @State private var justRestarted = false
    @State private var pendingSwitchMode: TerminalLaunchMode?

    private var container: ClaudeProfile { store.profile(id: containerID) ?? .newProfile() }
    private var isRunning: Bool { session.runningContainerID == containerID }

    var body: some View {
        List {
            Section {
                HStack(spacing: 11) {
                    MonogramTile(text: "C", background: AnyShapeStyle(Brand.coral), size: 42)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(AppStrings.claudeCode).font(.system(size: 17, weight: .bold))
                        Text(connectionLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    StatusPill(text: isRunning ? AppStrings.statusRunning : AppStrings.statusReady,
                               running: isRunning)
                }
                .padding(.vertical, 4)
            }

            Section {
                LabeledContent(AppStrings.connectionSection,
                               value: container.loginMode == .official ? AppStrings.officialLogin : AppStrings.thirdPartyAPI)
                if container.loginMode == .thirdParty {
                    LabeledContent(AppStrings.endpoint, value: container.baseURLDisplay)
                    LabeledContent(AppStrings.mainModel,
                                   value: container.mainModel.isEmpty ? AppStrings.modelNotSet : container.mainModel)
                }
                LabeledContent(AppStrings.proxy, value: container.proxyDisplay)
            } header: {
                Text(AppStrings.currentConfigSection)
            } footer: {
                Text(AppStrings.dashboardFooter)
            }

            if isRunning {
                Section {
                    Button {
                        session.restartSoft()
                        Haptics.success()
                        withAnimation { justRestarted = true }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            withAnimation { justRestarted = false }
                        }
                    } label: {
                        Label(justRestarted ? AppStrings.sessionRestarted : AppStrings.restartSession,
                              systemImage: justRestarted ? "checkmark.circle.fill" : "arrow.clockwise")
                            .foregroundStyle(justRestarted ? Brand.running : Brand.coral)
                            .animation(.default, value: justRestarted)
                    }
                    Button(role: .destructive) { showingRestartAppConfirm = true } label: {
                        Label(AppStrings.restartApp, systemImage: "power")
                    }
                } header: {
                    Text(AppStrings.terminalSession)
                } footer: {
                    Text(AppStrings.restartSessionHelp + "\n" + AppStrings.restartAppHelp)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(AppStrings.claudeCode)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(AppStrings.edit) { router.path.append(.claudeConfig(containerID)) }
            }
        }
        .safeAreaInset(edge: .bottom) { launchBar }
        .confirmationDialog(AppStrings.restartApp,
                            isPresented: $showingRestartAppConfirm,
                            titleVisibility: .visible) {
            Button(AppStrings.restartApp, role: .destructive) { exit(0) }
            Button(AppStrings.cancel, role: .cancel) {}
        } message: {
            Text(AppStrings.restartAppConfirm)
        }
        .confirmationDialog(AppStrings.switchContainerTitle,
                            isPresented: Binding(get: { pendingSwitchMode != nil },
                                                 set: { if !$0 { pendingSwitchMode = nil } }),
                            titleVisibility: .visible) {
            Button(AppStrings.switchAndRestart, role: .destructive) {
                if let m = pendingSwitchMode {
                    PendingContainerSwitch.stashAndRestart(containerID: containerID, mode: m)
                }
            }
            Button(AppStrings.cancel, role: .cancel) { pendingSwitchMode = nil }
        } message: {
            Text(String(format: AppStrings.switchContainerConfirm,
                        session.runningContainerName ?? "", container.displayName))
        }
    }

    private var connectionLine: String {
        container.loginMode == .official ? AppStrings.officialLogin
                                         : "\(AppStrings.thirdPartyAPI) · \(container.baseURLDisplay)"
    }

    /// Button-anchored permission menu — the menu pops from the "打开终端" button itself,
    /// offering only Claude's real permission modes (default / bypass). "普通模式" lives on
    /// the container home as 纯终端, so it is intentionally absent here.
    private var launchBar: some View {
        Menu {
            Section(AppStrings.choosePermission) {
                Button { launch(.claudeDefault) } label: {
                    Label(AppStrings.permDefault, systemImage: "checkmark.shield")
                }
                Button { launch(.claudeBypassPermissions) } label: {
                    Label(AppStrings.permMax, systemImage: "bolt.fill")
                }
            }
        } label: {
            HStack(spacing: 7) {
                Text(AppStrings.openTerminal).fontWeight(.semibold)
                Image(systemName: "chevron.up").font(.caption.weight(.bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Brand.coral, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func launch(_ mode: TerminalLaunchMode) {
        // A different container is live → confirm, then full-restart into this one.
        if session.conflicts(with: containerID) { pendingSwitchMode = mode; return }
        do {
            store.setActive(containerID)
            // Already running THIS container → type the command into the live shell
            // (single-Node can't reboot); otherwise boot with LSHELL_START_COMMAND.
            if session.relaunchIfRunning(command: mode.startupCommand) {
                if let cfg = session.currentConfig { router.path.append(.terminal(cfg)) }
            } else {
                let cfg = try store.makeLaunchConfig(for: container, launchMode: mode)
                router.path.append(.terminal(cfg))
            }
        } catch {
            router.errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 6 · Terminal

private struct TerminalScreen: View {
    let resourceRoot: String
    let launchConfig: ClaudeLaunchConfig
    @ObservedObject private var session = TerminalSession.shared

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "terminal").foregroundStyle(Brand.coral)
                VStack(alignment: .leading, spacing: 2) {
                    Text(launchConfig.profileName).font(.subheadline.weight(.semibold))
                    Text(launchConfig.workspace).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button { session.toggleKeyboard() } label: {
                    Image(systemName: session.isKeyboardVisible ? "keyboard.chevron.compact.down" : "keyboard")
                        .foregroundStyle(Brand.coral)
                }
                .accessibilityLabel(AppStrings.showKeyboard)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.black)

            TerminalHostView(resourceRoot: resourceRoot, launchConfig: launchConfig)
                .background(Color.black)
        }
        .background(Color.black.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) { TerminalKeyBar() }
        .navigationTitle(AppStrings.terminal)
        .navigationBarTitleDisplayMode(.inline)
        // The terminal renders a dark ANSI palette; keep this screen dark regardless of
        // the system appearance so foreground text stays legible.
        .preferredColorScheme(.dark)
    }
}

// MARK: - Diagnostics

private struct DiagnosticsView: View {
    @ObservedObject var store: ClaudeProfileStore

    var body: some View {
        List {
            Section(AppStrings.runtime) {
                LabeledContent(AppStrings.node, value: NodeRunner.shared.isStarted ? AppStrings.running : AppStrings.notStarted)
                LabeledContent(AppStrings.containers, value: "\(store.profiles.count)")
                LabeledContent(AppStrings.config, value: ClaudeProfileStore.storePath).font(.caption)
            }
            Section(AppStrings.activeProfile) {
                if let profile = store.activeProfile {
                    LabeledContent(AppStrings.name, value: profile.displayName)
                    LabeledContent(AppStrings.home, value: store.homePath(for: profile)).font(.caption)
                    LabeledContent(AppStrings.workspace, value: store.workspacePath(for: profile)).font(.caption)
                    LabeledContent(AppStrings.settings, value: store.settingsPath(for: profile)).font(.caption)
                } else {
                    Text(AppStrings.emptyContainersTitle).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(AppStrings.diagnostics)
    }
}

extension FileManager {
    static var documentsPath: String {
        NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
    }
    static var applicationSupportPath: String {
        NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true)[0]
    }
}
