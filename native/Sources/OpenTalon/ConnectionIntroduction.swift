import AppKit
import SwiftUI

struct ConnectionIntroduction: View {
    @Environment(WorkspaceModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable().frame(width: 48, height: 48).accessibilityHidden(true)
            Text("Use OpenTalon from your agent")
                .font(palette.display(30)).accessibilityAddTraits(.isHeader)
            Text("Use MCP to let Claude Code, Codex, Gemini CLI, or Claude chat read and edit your projects and tasks on this Mac.")
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 8) {
                Text("Try asking").font(.headline)
                Text("“List my OpenTalon projects.”")
                Text("“Which tasks are marked urgent?”")
                Text("“Show me the latest comments on my most recent task.”")
            }
            .textSelection(.enabled)
            Divider()
            Text("Your AI provider may receive the task details your agent reads. You can turn access off in Settings → Agent connection.")
                .font(.callout).foregroundStyle(palette.muted)
            HStack {
                Button("Not now") { model.sheet = nil }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Set up connection") { model.sheet = .connectionSetup }
                    .buttonStyle(GlassActionStyle(prominent: true)).keyboardShortcut(.defaultAction)
            }
        }
        .padding(26).frame(width: 480, alignment: .leading)
    }
}
