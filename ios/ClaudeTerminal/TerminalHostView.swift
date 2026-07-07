import SwiftUI
import SwiftTerm
import UIKit

/// Hosts the app's single persistent TerminalView (owned by TerminalSession) inside a
/// SwiftUI container. Because the emulator view is NOT recreated here, navigating away
/// from the terminal and back preserves scrollback and the running session (task 8).
///
/// A tap gesture re-focuses the terminal so the keyboard comes back even after it was
/// dismissed (task 7); the SwiftTerm view alone swallows taps as mouse events when a
/// TUI enables mouse reporting, so the explicit gesture is the reliable path.
struct TerminalHostView: UIViewRepresentable {
    let resourceRoot: String
    let launchConfig: ClaudeLaunchConfig

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let session = TerminalSession.shared
        session.prepare(config: launchConfig, resourceRoot: resourceRoot)

        let container = UIView()
        container.backgroundColor = .black

        let tv = session.terminalView
        tv.removeFromSuperview()
        tv.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(tv)
        NSLayoutConstraint.activate([
            tv.topAnchor.constraint(equalTo: container.topAnchor),
            tv.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            tv.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            tv.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        // Tap-to-focus: brings the keyboard back after it was dismissed. Non-blocking
        // so SwiftTerm still receives the touch for caret placement / mouse reporting.
        let tap = UITapGestureRecognizer(target: context.coordinator,
                                         action: #selector(Coordinator.handleTap))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        container.addGestureRecognizer(tap)

        DispatchQueue.main.async { session.focusKeyboard() }
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        @objc func handleTap() { TerminalSession.shared.focusKeyboard() }

        // Coexist with SwiftTerm's own tap/pan recognizers.
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
