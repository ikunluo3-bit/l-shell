import SwiftUI
import UIKit

// MARK: - Palette

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: alpha)
    }
}

/// The app's single accent (warm coral, Anthropic-adjacent) plus the few semantic
/// colors the UI needs. Coral is brand — used sparingly on primary actions and the
/// AI entry. Green is reserved for "running" status. Everything else stays neutral
/// and follows the system grouped-list palette so light/dark just work.
enum Brand {
    static let coral = Color(hex: 0xD97757)
    static let coralPress = Color(hex: 0xC25E42)
    static let coralInk = Color(hex: 0x8A3D22)
    static let running = Color(hex: 0x2FB552)
    static let runningInk = Color(hex: 0x1E7E3A)

    /// Adaptive light-coral fill for the AI entry card / tinted chips.
    static var coralTint: Color { coral.opacity(0.11) }
    static var coralHairline: Color { coral.opacity(0.24) }
    static var runningTint: Color { running.opacity(0.14) }
}

enum Haptics {
    static func tap(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .medium) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

// MARK: - AI tools

/// The AI coding tools the picker offers. Only tools that can actually run in the
/// on-device jitless single-Node runtime (pure JS / Node) are landable; native-binary
/// (Codex, OpenCode) and Python (Kimi) tools are deliberately absent, not "coming soon".
enum AITool: String, Identifiable, CaseIterable {
    case claudeCode
    case geminiCLI
    case qwenCode

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .geminiCLI:  return "Gemini CLI"
        case .qwenCode:   return "Qwen Code"
        }
    }

    var monogram: String {
        switch self {
        case .claudeCode: return "C"
        case .geminiCLI:  return "G"
        case .qwenCode:   return "Q"
        }
    }

    var isAvailable: Bool { self == .claudeCode }

    /// Right-hand subtitle in the picker.
    var vendorLine: String {
        switch self {
        case .claudeCode: return AppStrings.claudeVendorReady
        case .geminiCLI:  return AppStrings.geminiVendorSoon
        case .qwenCode:   return AppStrings.qwenVendorSoon
        }
    }

    var tileBackground: AnyShapeStyle {
        switch self {
        case .claudeCode:
            return AnyShapeStyle(Brand.coral)
        case .geminiCLI:
            return AnyShapeStyle(LinearGradient(colors: [Color(hex: 0x4E86F7), Color(hex: 0x8E77E8)],
                                                startPoint: .topLeading, endPoint: .bottomTrailing))
        case .qwenCode:
            return AnyShapeStyle(Color(hex: 0x7B57D6))
        }
    }
}

// MARK: - Reusable views

/// A rounded monogram tile (letter on a brand-colored square) used for AI-tool rows.
struct MonogramTile: View {
    let text: String
    let background: AnyShapeStyle
    var size: CGFloat = 30
    var dimmed: Bool = false

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
            .fill(background)
            .frame(width: size, height: size)
            .overlay(
                Text(text)
                    .font(.system(size: size * 0.5, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            )
            .saturation(dimmed ? 0.28 : 1)
            .opacity(dimmed ? 0.6 : 1)
    }
}

/// Large tappable entry on the container home (AI 编程模式 / 纯终端).
struct EntryCard: View {
    let systemIcon: String
    let title: String
    let subtitle: String
    var accent: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(accent ? AnyShapeStyle(Brand.coral) : AnyShapeStyle(Color(hex: 0x2A2621)))
                    .frame(width: 44, height: 44)
                    .overlay(
                        Image(systemName: systemIcon)
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(.white)
                    )
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(accent ? Brand.coralInk : Color.primary)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(
                accent ? AnyShapeStyle(Brand.coralTint)
                       : AnyShapeStyle(Color(.secondarySystemGroupedBackground)),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(accent ? Brand.coralHairline : Color(.separator).opacity(0.5),
                                  lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }
}

/// Light status strip shown on the container home when a session is live. Green means
/// running; the "接管" chip re-opens the terminal.
struct RunningStrip: View {
    let toolName: String
    let takeover: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 9) {
                    Circle()
                        .fill(Brand.running)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().stroke(Brand.running.opacity(0.25), lineWidth: 4))
                    Text(String(format: AppStrings.runningStripTitle, toolName))
                        .font(.system(size: 15, weight: .semibold))
                }
                Text(AppStrings.runningStripSub)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 17)
            }
            Spacer(minLength: 8)
            Button(action: takeover) {
                Text(AppStrings.takeover)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Brand.runningInk)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 7)
                    .background(Brand.runningTint, in: Capsule())
                    .overlay(Capsule().strokeBorder(Brand.running.opacity(0.24), lineWidth: 0.5))
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(Color(.separator).opacity(0.5), lineWidth: 0.5))
    }
}

/// A small pill for status ("就绪" / "运行中") — green when running, neutral otherwise.
struct StatusPill: View {
    let text: String
    var running: Bool

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(running ? Brand.running : Color.secondary).frame(width: 6, height: 6)
            Text(text).font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(running ? Brand.runningInk : Color.secondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .background(running ? Brand.runningTint : Color(.tertiarySystemFill), in: Capsule())
    }
}
