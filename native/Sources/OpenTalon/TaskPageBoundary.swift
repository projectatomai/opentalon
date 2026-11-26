import SwiftUI

/// Only grows a list when its loaded end reaches the actual scroll viewport.
/// An onAppear sentinel can run during offscreen layout and exhaust every page.
struct TaskPageBoundary: View {
    let space: String
    let viewportHeight: CGFloat
    let load: () -> Void

    var body: some View {
        Color.clear
            .frame(height: 1)
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(key: TaskPagePosition.self,
                                           value: geometry.frame(in: .named(space)).minY)
                }
            }
            .onPreferenceChange(TaskPagePosition.self) { position in
                if position < viewportHeight + 60 { load() }
            }
            .accessibilityHidden(true)
    }
}

private struct TaskPagePosition: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
