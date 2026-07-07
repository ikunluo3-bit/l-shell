import SwiftUI

/// A persistent key toolbar pinned above the terminal (via `.safeAreaInset`), NOT an
/// inputAccessoryView. That means it is ALWAYS fully visible — never truncated when the
/// software keyboard is hidden — and the navigation keys work even with no keyboard up.
/// When the keyboard appears it rides above it. Follows the system light/dark appearance.
struct TerminalKeyBar: View {
    private let session = TerminalSession.shared

    var body: some View {
        HStack(spacing: 6) {
            key("esc") { session.sendBytes([0x1b]) }
            key("tab") { session.sendBytes([0x09]) }
            key("ctrl") { session.armControl() }
            key("←") { session.sendBytes([0x1b, 0x5b, 0x44]) }
            key("↓") { session.sendBytes([0x1b, 0x5b, 0x42]) }
            key("↑") { session.sendBytes([0x1b, 0x5b, 0x41]) }
            key("→") { session.sendBytes([0x1b, 0x5b, 0x43]) }
            key("⌨\u{fe0e}", tint: Brand.coral) { session.toggleKeyboard() }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.bar)
    }

    private func key(_ label: String, tint: Color = .primary, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 16, weight: .medium, design: .monospaced))
                .foregroundStyle(tint)
                .frame(maxWidth: .infinity, minHeight: 36)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
