import AppKit
import SwiftUI

private struct ProjectFolder: Decodable {
    let workingFolder: String
    let effectiveFolder: String
    let revision: Int
}

struct ProjectFolderEditor: View {
    @Environment(WorkspaceModel.self) private var model
    @Environment(\.palette) private var palette
    let board: Board
    @State private var saved: ProjectFolder?
    @State private var folder = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Project agent folder").font(palette.display(27)).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Cancel") { model.sheet = nil }.frame(minWidth: 72).keyboardShortcut(.cancelAction)
            }
            Text(board.name).font(.headline)
            Text("New agent sessions for this project use this folder, including tasks sent from iPhone and iPad. Existing conversations keep their original folder.")
                .foregroundStyle(palette.muted).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 10) {
                Label(folder.isEmpty ? "Global OpenTalon folder" : "Custom project folder", systemImage: "folder")
                    .fontWeight(.semibold)
                Text(folder.isEmpty ? "Uses the folder selected in Settings → Task agent." : folder)
                    .font(.callout).foregroundStyle(palette.muted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if folder.isEmpty, saved?.workingFolder.isEmpty == true, let path = saved?.effectiveFolder, !path.isEmpty {
                    Text(path).font(.caption).foregroundStyle(palette.muted).textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).surface(12)
            HStack {
                Button("Choose project folder…", systemImage: "folder.badge.plus") { chooseFolder() }
                Button("Use global folder") { folder = "" }.disabled(folder.isEmpty)
            }
            Text("You can create a folder in the picker or choose one on an external drive. If a custom folder is unavailable, sending waits for you to reconnect or change it.")
                .font(.caption).foregroundStyle(palette.muted).fixedSize(horizontal: false, vertical: true)
            if let error { Text(error).font(.caption).foregroundStyle(palette.danger) }
            HStack {
                Spacer()
                Button("Save", action: save).glassPrimary().frame(minWidth: 72)
                    .disabled(saved == nil || saved?.workingFolder == folder)
            }
        }
        .padding(24).frame(width: 620).disabled(busy).interactiveDismissDisabled(busy)
        .task {
            do {
                let value: ProjectFolder = try await model.service.call("get_project_folder", ["id": board.id])
                saved = value
                folder = value.workingFolder
            } catch { self.error = error.localizedDescription }
        }
    }

    private func chooseFolder() {
        busy = true
        Task {
            defer { busy = false }
            guard let url = await chooseDirectory("Choose or create the agent folder for \(board.name)", prompt: "Use this folder") else { return }
            folder = url.path
        }
    }

    private func save() {
        guard let saved else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let _: ProjectFolder = try await model.write("set_project_folder", [
                    "id": board.id, "expectedRevision": saved.revision, "workingFolder": folder
                ])
                model.sheet = nil
            } catch { self.error = error.localizedDescription }
        }
    }
}
