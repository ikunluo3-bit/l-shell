// Static regression tests for the iOS app shell (ios/). There is no Xcode on CI, so
// these validate what can be validated without compiling:
//   - Info.plist / project.yml / asset catalog contents (launch color, pins, keys)
//   - bundle-runtime.sh syntax + sanity-check step + no duplicated command blocks
//   - Swift sources: syntax (swiftc -parse, guarded) + audit-fix invariants
//     (no FileHandle.write on input paths, no fd-3 steal, SIGPIPE ignored,
//      output coalescing, pending-resize buffering, profile-scoped Keychain).
// Run under: node --jitless test/test-ios-app.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const IOS = path.join(ROOT, 'ios');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const read = (p) => fs.readFileSync(p, 'utf8');
const tryExec = (file, args) => {
  try { return { out: execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
};

// --- Info.plist ---
const plistPath = path.join(IOS, 'ClaudeTerminal', 'Info.plist');
const plist = read(plistPath);
if (fs.existsSync('/usr/bin/plutil')) {
  ok(tryExec('/usr/bin/plutil', ['-lint', plistPath]).code === 0, 'Info.plist lints (plutil)');
} else {
  console.log('  - skip: plutil not available');
}
ok(plist.includes('<key>NSLocalNetworkUsageDescription</key>'), 'Info.plist has NSLocalNetworkUsageDescription');
ok(/<key>UIColorName<\/key>\s*<string>LaunchBackground<\/string>/.test(plist), 'launch screen uses LaunchBackground color');
ok(plist.includes('NSAllowsLocalNetworking'), 'Info.plist keeps NSAllowsLocalNetworking');
ok(plist.includes('UIFileSharingEnabled'), 'Info.plist keeps UIFileSharingEnabled');

// --- project.yml ---
const proj = read(path.join(IOS, 'project.yml'));
ok(/deploymentTarget:\s*\n\s*iOS:\s*"18\.0"/.test(proj), 'deployment target is iOS 18.0');
ok(/SwiftTerm:\s*\n\s*url:.*SwiftTerm\s*\n\s*exactVersion:\s*"1\.13\.0"/.test(proj), 'SwiftTerm pinned exactVersion 1.13.0');
ok(!/SwiftTerm:\s*\n\s*url:[^\n]*\n\s*from:/.test(proj), 'no floating "from:" pin on SwiftTerm');
ok(proj.includes('path: ClaudeTerminal'), 'sources include ClaudeTerminal dir (picks up Assets.xcassets)');

// --- launch asset catalog ---
const colorset = JSON.parse(read(path.join(
  IOS, 'ClaudeTerminal', 'Assets.xcassets', 'LaunchBackground.colorset', 'Contents.json')));
const c = colorset.colors?.[0];
ok(c?.idiom === 'universal', 'LaunchBackground colorset is universal');
ok(c?.color?.['color-space'] === 'srgb', 'LaunchBackground is sRGB');
{
  const comp = c?.color?.components || {};
  const black = ['red', 'green', 'blue'].every((k) => parseFloat(comp[k]) === 0) && parseFloat(comp.alpha) === 1;
  ok(black, 'LaunchBackground is opaque black');
}
JSON.parse(read(path.join(IOS, 'ClaudeTerminal', 'Assets.xcassets', 'Contents.json')));
ok(true, 'Assets.xcassets top-level Contents.json parses');

// --- bundle-runtime.sh ---
const shPath = path.join(IOS, 'scripts', 'bundle-runtime.sh');
const sh = read(shPath);
ok(tryExec('bash', ['-n', shPath]).code === 0, 'bundle-runtime.sh: bash -n clean');
ok(sh.includes('bootstrap.js') && sh.includes('vendor/claude-code/cli.js'), 'bundle-runtime.sh verifies bootstrap.js + cli.js');
{
  // No duplicated command blocks: every non-comment command line appears once.
  const lines = sh.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const dupes = lines.filter((l, i) => lines.indexOf(l) !== i);
  ok(dupes.length === 0, `bundle-runtime.sh has no duplicated command lines${dupes.length ? ' (' + dupes[0] + ')' : ''}`);
}

// --- Swift sources: audit-fix invariants (static) ---
const swiftDir = path.join(IOS, 'ClaudeTerminal');
const swiftFiles = fs.readdirSync(swiftDir).filter((f) => f.endsWith('.swift'));
ok(swiftFiles.includes('KeychainStore.swift'), 'KeychainStore.swift exists');
ok(swiftFiles.includes('AppStrings.swift'), 'AppStrings.swift exists');
ok(swiftFiles.includes('ClaudeProfile.swift'), 'ClaudeProfile.swift exists');
ok(swiftFiles.includes('ClaudeProfileStore.swift'), 'ClaudeProfileStore.swift exists');
ok(swiftFiles.includes('ClaudeSettingsWriter.swift'), 'ClaudeSettingsWriter.swift exists');
ok(swiftFiles.includes('ClaudeModelService.swift'), 'ClaudeModelService.swift exists');

const runner = read(path.join(swiftDir, 'NodeRunner.swift'));
ok(!runner.includes('fileHandleForWriting.write('), 'NodeRunner: no FileHandle.write on input paths (EPIPE NSException)');
ok(runner.includes('Darwin.write('), 'NodeRunner: raw Darwin.write loop');
ok(runner.includes('EINTR'), 'NodeRunner: EINTR retry in write loop');
ok(/DispatchQueue\(label:\s*"node-input"\)/.test(runner), 'NodeRunner: dedicated serial input queue');
ok(/signal\(SIGPIPE,\s*SIG_IGN\)/.test(runner), 'NodeRunner: SIGPIPE ignored process-wide');
ok(!/dup2\([^\n]*,\s*3\)/.test(runner), 'NodeRunner: fd 3 no longer stolen via dup2');
ok(runner.includes('CLAUDE_IOS_CONTROL_FD'), 'NodeRunner: control fd exported via CLAUDE_IOS_CONTROL_FD');
ok(runner.includes('sessionAlive'), 'NodeRunner: sessionAlive flag present');
ok(runner.includes('started = false'), 'NodeRunner: started reset when node_start returns');
ok(runner.includes('endSessionUIHint'), 'NodeRunner: endSessionUIHint exists');
ok(runner.includes('pendingResize'), 'NodeRunner: pre-launch resize buffered');
ok(runner.includes('asyncAfter') && runner.includes('flushScheduled'), 'NodeRunner: output coalescing (single scheduled flush)');
ok(!/readabilityHandler[\s\S]{0,200}DispatchQueue\.main\.async \{ self\.onOutput/.test(runner), 'NodeRunner: no per-chunk main.async in readabilityHandler');
ok(runner.includes('isIdleTimerDisabled = true') && runner.includes('isIdleTimerDisabled = false'), 'NodeRunner: idle timer toggled with session');
ok(/"TZ":\s*TimeZone\.current\.identifier/.test(runner), 'NodeRunner: TZ env from device timezone');
ok(/"LANG":\s*"en_US\.UTF-8"/.test(runner), 'NodeRunner: LANG=en_US.UTF-8');

const content = read(path.join(swiftDir, 'ContentView.swift'));
ok(!content.includes('@AppStorage("credential")'), 'ContentView: credential no longer in UserDefaults');
ok(content.includes('NavigationStack') && content.includes('ContainersListView(store: store)'), 'ContentView: native container list is root');
ok(content.includes('makeLaunchConfig(for: container, launchMode: mode)') && content.includes('TerminalScreen'), 'ContentView: terminal is launched from selected container/profile');
ok(!/TerminalHostView\(resourceRoot:\s*resourceRoot,\s*home:/.test(content), 'ContentView: no unconditional terminal boot on app launch');
ok(content.includes('Color.black.ignoresSafeArea()'), 'ContentView: full-bleed black background');
ok(!/TerminalHostView\([^\n]*\)\s*\.ignoresSafeArea/.test(content), 'ContentView: terminal host respects safe areas');
ok(content.includes('ContainersListView') && content.includes('ContainerHomeView') && content.includes('AppStrings.createContainer'), 'ContentView: L Shell container flow is present');
ok(content.includes('AIToolPickerView') && content.includes('ForEach(soon)') && content.includes('AppStrings.comingSoon'), 'ContentView: unavailable AI tools are shown as coming soon');
ok(content.includes('AppStrings.containers') && content.includes('AppStrings.diagnostics'), 'ContentView: visible dashboard strings are localized');
ok(content.includes('AppStrings.fetchModels') && content.includes('AppStrings.noKeyTitle') && content.includes('AppStrings.proxyEndpointPlaceholder'), 'ContentView: profile editor strings are localized');
ok(content.includes('ModelField(title: AppStrings.mainModel') && content.includes('ModelField(title: AppStrings.opusModel') && content.includes('ModelField(title: AppStrings.fastModel'), 'ContentView: three model selectors are present');

const appStrings = read(path.join(swiftDir, 'AppStrings.swift'));
ok(appStrings.includes('enum AppStrings'), 'AppStrings: localization helper exists');
ok(appStrings.includes('AppleLanguages') && appStrings.includes('Locale.preferredLanguages'), 'AppStrings: follows system language preferences');
ok(appStrings.includes('"L Shell"') && appStrings.includes('"容器"') && appStrings.includes('"敬请期待"'), 'AppStrings: Simplified Chinese container UI strings present');

const keychain = read(path.join(swiftDir, 'KeychainStore.swift'));
for (const api of ['SecItemCopyMatching', 'SecItemAdd', 'SecItemUpdate', 'SecItemDelete']) {
  ok(keychain.includes(api), `KeychainStore uses ${api}`);
}
ok(keychain.includes('kSecAttrAccessibleAfterFirstUnlock'), 'KeychainStore: AfterFirstUnlock accessibility');
ok(keychain.includes('"ClaudeTerminal"') && keychain.includes('"claude.profile.\\(profileID).credential"'), 'KeychainStore: profile-scoped service/account');
ok(keychain.includes('loadLegacyCredential') && keychain.includes('deleteLegacyCredential'), 'KeychainStore: legacy credential migration hooks');

const profile = read(path.join(swiftDir, 'ClaudeProfile.swift'));
ok(profile.includes('struct ClaudeProfile') && profile.includes('Codable') && profile.includes('credential'), 'ClaudeProfile: Codable profile model includes stored credential');
ok(profile.includes('baseURL') && profile.includes('mainModel') && profile.includes('opusModel') && profile.includes('fastModel'), 'ClaudeProfile: endpoint/three-model fields present');
ok(profile.includes('authMode') && profile.includes('proxyMode') && profile.includes('proxyEndpoint') && profile.includes('workspaceName') && profile.includes('isActive'), 'ClaudeProfile: auth/proxy/workspace/active fields present');
ok(profile.includes('AppStrings.apiKey') && profile.includes('AppStrings.direct'), 'ClaudeProfile: enum display strings are localized');
ok(profile.includes('case custom') && profile.includes('normalizedProxyURL') && !/local\d+/.test(profile), 'ClaudeProfile: proxy uses custom endpoint instead of bundled fixed proxy');

const store = read(path.join(swiftDir, 'ClaudeProfileStore.swift'));
ok(store.includes('ApplicationSupport') || store.includes('applicationSupportPath'), 'ClaudeProfileStore: persists under Application Support');
ok(store.includes('containers.json'), 'ClaudeProfileStore: uses containers.json');
ok(store.includes('Documents') || store.includes('documentsPath'), 'ClaudeProfileStore: profile containers live under Documents');
ok(store.includes('containers') && store.includes('home') && store.includes('workspace'), 'ClaudeProfileStore: creates home/workspace container paths');
ok(store.includes('migrateLegacyCredential') && store.includes('removeObject(forKey: "credential")'), 'ClaudeProfileStore: one-time UserDefaults credential migration');
{
  const concreteURLs = [...(profile + store).matchAll(/https?:\/\/[^"']+/g)]
    .map((match) => match[0])
    .filter((value) => !value.includes('\\('));
  ok(!concreteURLs.some((value) => !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(value)), 'Claude defaults: no bundled provider endpoint URL');
}
ok(profile.includes('mainModel: ""') && profile.includes('opusModel: ""') && profile.includes('fastModel: ""'), 'Claude defaults: model fields start empty');

const writer = read(path.join(swiftDir, 'ClaudeSettingsWriter.swift'));
ok(writer.includes('settings.json') && writer.includes('JSONSerialization'), 'ClaudeSettingsWriter: writes .claude/settings.json');
ok(writer.includes('let settingsEnv = environment(for: profile, includeSecret: true)'), 'ClaudeSettingsWriter: settings env includes local profile credential');
ok(writer.includes('env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = profile.opusModel'), 'ClaudeSettingsWriter: writes independent opus model only when configured');
ok(writer.includes('ANTHROPIC_API_KEY') && writer.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'ClaudeSettingsWriter: supports API key and OAuth env');
ok(writer.includes('"HTTPS_PROXY": profile.proxyURL') && writer.includes('"HTTP_PROXY": profile.proxyURL'), 'ClaudeSettingsWriter: proxy env comes from custom profile endpoint');

const models = read(path.join(swiftDir, 'ClaudeModelService.swift'));
ok(models.includes('/v1/models') && models.includes('x-api-key'), 'ClaudeModelService: fetches /v1/models with API key auth');
ok(models.includes('parseModelIDs') && models.includes('JSONSerialization'), 'ClaudeModelService: parses flexible model responses');

const app = read(path.join(swiftDir, 'ClaudeTerminalApp.swift'));
ok(app.includes('scenePhase'), 'App: observes scenePhase');
ok(app.includes('didReceiveMemoryWarningNotification'), 'App: memory-warning note registered');
ok(app.includes('resumed') && app.includes('feedNote'), 'App: resume note routed through NodeRunner');

const host = read(path.join(swiftDir, 'TerminalHostView.swift'));
const terminalSession = read(path.join(swiftDir, 'TerminalSession.swift'));
const terminalKeyBar = read(path.join(swiftDir, 'TerminalKeyBar.swift'));
ok(terminalSession.includes('handleSize(cols: Int, rows: Int)') && terminalSession.includes('booted = true') && terminalSession.includes('NodeRunner.shared.start'), 'TerminalSession: first-size boot trigger intact');
ok(host.includes('session.focusKeyboard()') && terminalSession.includes('becomeFirstResponder') && terminalKeyBar.includes('toggleKeyboard()'), 'TerminalHostView/Session: requests focus so iOS shows the software keyboard');

// --- Swift syntax (parse-only; UIKit/SwiftUI imports are not resolved by -parse) ---
// `arch -arm64` fallback: an x86_64 Node (Rosetta) spawns x86_64 tool shims, which
// fail against an arm64-only CommandLineTools install.
let swiftcCmd = null;
for (const cand of [['swiftc'], ['/usr/bin/arch', '-arm64', 'swiftc'], ['xcrun', 'swiftc']]) {
  if (tryExec(cand[0], [...cand.slice(1), '-version']).code === 0) { swiftcCmd = cand; break; }
}
if (swiftcCmd) {
  for (const f of swiftFiles) {
    const r = tryExec(swiftcCmd[0], [...swiftcCmd.slice(1), '-parse', path.join(swiftDir, f)]);
    ok(r.code === 0, `swiftc -parse ${f}${r.code ? '\n' + r.out : ''}`);
  }
} else {
  console.log('  - skip: swiftc not available (syntax not verified)');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
