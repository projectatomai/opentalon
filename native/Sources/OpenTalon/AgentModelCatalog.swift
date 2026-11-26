import CompanionCore
import SwiftUI

private struct ModelOverride: Codable {
    let agent: PhoneAgent
    let id: String
    let title: String
    let hidden: Bool
}

private struct ModelCatalog: Decodable {
    let models: [AgentModelChoice]
    let defaults: [AgentModelChoice]
    let overrides: [ModelOverride]
    let catalogRevision: Int
}

private struct EditableModel: Identifiable {
    let id = UUID()
    let agent: PhoneAgent
    var modelID: String
    var title: String
}

struct AgentModelCatalogEditor: View {
    @Environment(WorkspaceModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var catalog: ModelCatalog?
    @State private var rows: [EditableModel] = []
    @State private var agent = PhoneAgent.codex
    @State private var busy = false
    @State private var error: String?
    @State private var resetAgents: Set<PhoneAgent> = []

    private var valid: Bool {
        let keys = rows.map { $0.agent.rawValue + ":" + $0.modelID.trimmingCharacters(in: .whitespacesAndNewlines) }
        return Set(keys).count == keys.count && rows.allSatisfy {
            !$0.modelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Agent models").font(palette.display(27)).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Cancel") { dismiss() }.frame(minWidth: 72).keyboardShortcut(.cancelAction)
            }
            Text("Your iPhone and iPad receive this list from your Mac. App updates add current models while keeping your custom names, models, and hidden choices.")
                .font(.callout).foregroundStyle(palette.muted).fixedSize(horizontal: false, vertical: true)
            BoardDropdown(selection: $agent, title: "Agent", symbol: "terminal",
                          choices: PhoneAgent.allCases, compact: true,
                          agentBrand: { Agent(rawValue: $0.rawValue) ?? .codex }, label: \.title)
            ThemedScrollView {
                VStack(spacing: 12) {
                    ForEach($rows) { $row in
                        if row.agent == agent {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    TextField("Display name", text: $row.title)
                                        .accessibilityLabel("Model display name")
                                    Button {
                                        rows.removeAll { $0.id == row.id }
                                    } label: { Label("Hide model", systemImage: "minus.circle") }
                                    .labelStyle(.iconOnly)
                                    .help("Hide this model from your choices")
                                }
                                TextField("Model ID", text: $row.modelID)
                                    .font(.system(.caption, design: .monospaced))
                                    .accessibilityLabel("Model ID")
                            }
                            .textFieldStyle(.plain).padding(12).surface(10)
                        }
                    }
                }.padding(.trailing, 5)
            }.frame(height: min(360, max(180, CGFloat(rows.filter { $0.agent == agent }.count) * 90)))
            HStack {
                Button("Add model", systemImage: "plus") {
                    rows.append(EditableModel(agent: agent, modelID: "", title: ""))
                }
                Button("Use current defaults") {
                    resetAgents.insert(agent)
                    rows.removeAll { $0.agent == agent }
                    rows.append(contentsOf: (catalog?.defaults ?? []).filter { $0.agent == agent }.map {
                        EditableModel(agent: $0.agent, modelID: $0.id, title: $0.title)
                    })
                }
                .disabled(catalog == nil)
            }
            Text(agent == .gemini
                 ? "Agent default sends the first Gemini model listed here. A custom model must be supported by Gemini and your Google plan."
                 : "Agent default is always available. A custom model must be supported by its agent and your account.")
                .font(.caption).foregroundStyle(palette.muted).fixedSize(horizontal: false, vertical: true)
            if let error {
                Text(error).font(.caption).foregroundStyle(palette.danger)
                Button("Reload and discard edits") { Task { await load() } }
            }
            HStack {
                Spacer()
                Button("Save", action: save).glassPrimary().frame(minWidth: 72)
                    .disabled(catalog == nil || !valid)
            }
        }
        .padding(24).frame(width: 630)
        .foregroundStyle(palette.text).tint(palette.accent).background(palette.panel)
        .buttonStyle(GlassActionStyle()).disabled(busy)
        .interactiveDismissDisabled(busy)
        .task { await load() }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            let value: ModelCatalog = try await model.service.call("get_agent_models")
            catalog = value
            rows = value.models.map { EditableModel(agent: $0.agent, modelID: $0.id, title: $0.title) }
            error = nil
            resetAgents = []
        } catch { self.error = error.localizedDescription }
    }

    private func save() {
        guard let catalog else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let visible = rows.map { (agent: $0.agent, id: $0.modelID.trimmingCharacters(in: .whitespacesAndNewlines),
                                          title: $0.title.trimmingCharacters(in: .whitespacesAndNewlines)) }
                var overrides: [[String: Any]] = catalog.defaults.compactMap { original in
                    guard !visible.contains(where: { $0.agent == original.agent && $0.id == original.id }) else { return nil }
                    return ["agent": original.agent.rawValue, "id": original.id, "title": original.title, "hidden": true]
                }
                // Keep hidden older choices even when a later app no longer ships them.
                overrides += catalog.overrides.filter { old in
                    old.hidden && !resetAgents.contains(old.agent) && !catalog.defaults.contains(where: { $0.agent == old.agent && $0.id == old.id }) &&
                        !visible.contains(where: { $0.agent == old.agent && $0.id == old.id })
                }.map { ["agent": $0.agent.rawValue, "id": $0.id, "title": $0.title, "hidden": true] }
                overrides += visible.compactMap { entry in
                    let explicitlyKept = !resetAgents.contains(entry.agent) && catalog.overrides.contains {
                        !$0.hidden && $0.agent == entry.agent && $0.id == entry.id && $0.title == entry.title
                    }
                    if !explicitlyKept && catalog.defaults.contains(where: { $0.agent == entry.agent && $0.id == entry.id && $0.title == entry.title }) { return nil }
                    return ["agent": entry.agent.rawValue, "id": entry.id, "title": entry.title, "hidden": false]
                }
                let _: ModelCatalog = try await model.write("set_agent_models", [
                    "expectedCatalogRevision": catalog.catalogRevision, "overrides": overrides
                ])
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
