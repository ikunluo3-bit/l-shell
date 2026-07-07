import SwiftUI
import Combine
import UIKit

@main
struct ClaudeTerminalApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var wasBackgrounded = false

    init() {
        NSLog("[lshell] app init")
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .statusBarHidden(true)
                .onAppear { NSLog("[lshell] ContentView onAppear") }
                .onReceive(NotificationCenter.default.publisher(
                    for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                    NodeRunner.shared.feedNote(AppStrings.memoryPressureWarning)
                }
        }
        .onChange(of: scenePhase) { phase in
            // iOS suspends Node while backgrounded; nothing to tear down. On return,
            // surface a note so an interrupted stream isn't mistaken for a hang.
            switch phase {
            case .background:
                wasBackgrounded = true
            case .active:
                if wasBackgrounded {
                    wasBackgrounded = false
                    NodeRunner.shared.feedNote(AppStrings.resumedAfterBackground)
                }
            default:
                break
            }
        }
    }
}
