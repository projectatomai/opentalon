import Foundation
import Testing
@testable import CompanionCore

@Test @MainActor func mcpAvailabilitySyncsBothDirectionsWithoutATaskEdit() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    let transport = LocalCompanionTransport(directory: folder)
    try await transport.prepare(account: "test")
    let id = UUID()
    let legacy = PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [], availableAgents: [.codex])
    #expect(!legacy.canUseAgents)
    var cached = legacy
    for ready in [false, true, false, true] {
        let updated = PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [], availableAgents: [.codex], agentConnectionReady: ready)
        #expect(updated.shouldReplace(cached))
        try await transport.publish(updated)
        guard case .updated(let incoming) = try await transport.snapshot(newerThan: cached) else {
            Issue.record("MCP state was cached at the same task revision"); return
        }
        #expect(incoming.canUseAgents == ready)
        cached = incoming
    }
    let encoded = try JSONEncoder().encode(cached)
    #expect(try JSONDecoder().decode(PhoneSnapshot.self, from: encoded).canUseAgents)
}

@Test func doneOrderUsesRecordedCompletionAndStableLegacyFallback() {
    func task(_ id: String, created: Double?, completed: Double? = nil) -> PhoneTask {
        PhoneTask(id: id, projectID: "project", title: id, notes: "", definitionOfDone: "", status: .done,
                  priority: .none, dueDate: nil, revision: 1, assigned: false,
                  createdAt: created.map(Date.init(timeIntervalSinceReferenceDate:)),
                  completedAt: completed.map(Date.init(timeIntervalSinceReferenceDate:)))
    }
    let items = [task("legacy-new", created: 100), task("legacy-undated", created: nil),
                 task("completed-last", created: 1, completed: 90), task("legacy-first", created: 50),
                 task("completed-first", created: 30, completed: 40)]
    #expect(DoneOrder.recent.ordered(items, completionDate: \.completedAt, creationDate: \.createdAt).map(\.id)
            == ["completed-last", "completed-first", "legacy-new", "legacy-first", "legacy-undated"])
    #expect(DoneOrder.oldest.ordered(items, completionDate: \.completedAt, creationDate: \.createdAt).map(\.id)
            == ["completed-first", "completed-last", "legacy-first", "legacy-new", "legacy-undated"])
    #expect(DoneOrder.manual.ordered(items, completionDate: \.completedAt, creationDate: \.createdAt).map(\.id)
            == items.map(\.id))
}

@Test @MainActor func cardDatesSyncWithoutChangingTheWorkspaceRevision() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    let transport = LocalCompanionTransport(directory: folder)
    try await transport.prepare(account: "test")

    let workspace = UUID()
    let created = Date(timeIntervalSinceReferenceDate: 15)
    let completed = created.addingTimeInterval(10)
    let updated = completed.addingTimeInterval(10)
    let trashed = updated.addingTimeInterval(10)
    func task(updatedAt: Date?) -> PhoneTask {
        PhoneTask(id: "done", projectID: "personal", title: "Completed", notes: "", definitionOfDone: "",
                  status: .done, priority: .none, dueDate: nil, revision: 4, assigned: false,
                  createdAt: created, completedAt: completed, updatedAt: updatedAt)
    }
    let legacy = PhoneSnapshot(workspaceID: workspace, revision: 5, projects: [], tasks: [task(updatedAt: nil)],
                               trashedTasks: [PhoneTrashedTask(id: "trash", projectID: "personal", title: "Archived", revision: 5)],
                               agentConnectionReady: false)
    try await transport.publish(legacy)
    let current = PhoneSnapshot(workspaceID: workspace, revision: 5, projects: [], tasks: [task(updatedAt: updated)],
                                trashedTasks: [PhoneTrashedTask(id: "trash", projectID: "personal", title: "Archived", revision: 5,
                                                               updatedAt: trashed, deletedAt: trashed)],
                                agentConnectionReady: false, includesTaskUpdateDates: true)
    try await transport.publish(current)
    guard case .updated(let incoming) = try await transport.snapshot(newerThan: legacy) else {
        Issue.record("Item timestamps did not reach a phone holding the same workspace revision.")
        return
    }
    #expect(incoming.tasks.first?.updatedAt == updated)
    #expect(incoming.tasks.first?.completedAt == completed)
    #expect(incoming.trashedTasks?.first?.deletedAt == trashed)
    #expect(incoming.trashedTasks?.first?.updatedAt == trashed)
    #expect(!legacy.shouldReplace(current))

    let decoded = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONEncoder().encode(legacy))
    #expect(decoded.tasks.first?.updatedAt == nil)
    #expect(decoded.trashedTasks?.first?.deletedAt == nil)
}

@Test func markdownCodeFencesKeepNestedMarkersInsideTheCodeBlock() {
    let fence = PlanCodeFence("````swift")!
    #expect(!fence.closes(with: "```"))
    #expect(!fence.closes(with: "~~~~"))
    #expect(!fence.closes(with: "````comment"))
    #expect(fence.closes(with: "  `````  "))
    #expect(PlanCodeFence("~~~swift")!.closes(with: "~~~"))
    #expect(PlanCodeFence("`inline`") == nil)
}

@Test func markdownPlansKeepUnicodeAndSafeFilenamesAndRejectInvalidDocuments() throws {
    let markdown = "# Plan\n\n- [ ] Review café notes.\n\n```swift\nprint(\"hello\")\n```\n"
    #expect(try TaskPlan.decode(Data(markdown.utf8)) == markdown)
    #expect(TaskPlan.filename(reference: "ink-001") == "INK-001-plan.md")
    #expect(!TaskPlan.filename(reference: "../../file").contains("/"))
    #expect(throws: TaskPlan.PlanError.self) { try TaskPlan.decode(Data([0xff, 0xfe, 0x00])) }
    #expect(throws: TaskPlan.PlanError.self) { try TaskPlan.validate("a\0b") }
    #expect(throws: TaskPlan.PlanError.self) { try TaskPlan.validate(String(repeating: "x", count: 100_001)) }
    #expect(TaskPlan.requested(in: "Create a task with a plan to review the launch"))
    #expect(!TaskPlan.requested(in: "Review the planet illustration"))
    #expect(TaskReference.normalized(in: "Set ink-1 priority to High") == "INK-001")
    #expect(TaskReference.normalized(in: "Open INK–001") == "INK-001")
    #expect(TaskReference.normalized(in: "01a1cbb7-abc-1234-8610-89b71dfe8a4a") == nil)
}

@Test func planRequestsRetainExpectedContentAndUpgradeOlderSnapshots() throws {
    let workspace = UUID()
    let old = PhoneSnapshot(workspaceID: workspace, revision: 3, projects: [], tasks: [])
    let upgraded = PhoneSnapshot(workspaceID: workspace, revision: 3, projects: [], tasks: [], supportsTaskPlans: true)
    #expect(!old.supportsTaskPlans)
    #expect(upgraded.shouldReplace(old))
    let request = PhoneRequest(workspaceID: workspace, action: .savePlan(taskID: "stable-task-id", expectedMarkdown: "# Original", markdown: "# Revised"))
    let restored = try JSONDecoder().decode(PhoneRequest.self, from: JSONEncoder().encode(request))
    #expect(restored.id == request.id)
    #expect(restored.taskID == "stable-task-id")
    guard case .savePlan(_, let expected, let markdown) = restored.action else { Issue.record("Wrong plan action"); return }
    #expect(expected == "# Original")
    #expect(markdown == "# Revised")
    let capture = PhoneRequest(workspaceID: workspace, action: .create(projectID: "personal", title: "Task", notes: "Summary", priority: .medium,
                                                                       sendToAgent: false, planMarkdown: "# Steps"))
    let saved = try JSONDecoder().decode(PhoneRequest.self, from: JSONEncoder().encode(capture))
    guard case .create(_, _, _, _, _, _, _, _, _, _, let plan, _) = saved.action else { Issue.record("Wrong create action"); return }
    #expect(plan == "# Steps")
}

@Test func taskOrganizationCapabilityAndRequestsRoundTrip() throws {
    let workspace = UUID()
    let legacy = PhoneSnapshot(workspaceID: workspace, revision: 7, projects: [], tasks: [])
    let current = PhoneSnapshot(workspaceID: workspace, revision: 7, projects: [], tasks: [],
                                supportsTaskOrganization: true)
    #expect(!legacy.supportsTaskOrganization)
    #expect(current.shouldReplace(legacy))
    #expect(try JSONDecoder().decode(PhoneSnapshot.self, from: JSONEncoder().encode(current)).supportsTaskOrganization)
    for destination: PhoneRequest.TaskDestination in [.archive, .trash, .active] {
        let request = PhoneRequest(workspaceID: workspace, action: .organizeTask(taskID: "task", destination: destination))
        let restored = try JSONDecoder().decode(PhoneRequest.self, from: JSONEncoder().encode(request))
        #expect(restored.id == request.id)
        #expect(restored.taskID == "task")
        #expect(restored.changesTask)
        guard case .organizeTask(_, let decoded) = restored.action else {
            Issue.record("Organization request did not round-trip")
            return
        }
        #expect(decoded == destination)
    }
}

@MainActor
@Test func reviewInvitationCanBeRequestedOnceAfterThreeActivities() throws {
    let suite = "OpenTalonReviewTests." + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }

    let initial = OpenTalonReviewMilestone(defaults: defaults)
    initial.recordActivity()
    initial.recordActivity()
    #expect(!initial.takeRequest())

    let resumed = OpenTalonReviewMilestone(defaults: defaults)
    resumed.recordActivity()
    #expect(resumed.isDue)
    #expect(resumed.takeRequest())
    #expect(!resumed.takeRequest())

    let afterDismissal = OpenTalonReviewMilestone(defaults: defaults)
    afterDismissal.recordActivity()
    #expect(!afterDismissal.takeRequest())
}

@Test func retriesKeepRequestIdentityAndWaitForTheAppliedRevision() throws {
    let workspace = UUID()
    let request = PhoneRequest(workspaceID: workspace, action: .create(
        projectID: "work", title: "Private task", notes: "Do the work", priority: .urgent, sendToAgent: true
    ))
    let bytes = try JSONEncoder().encode(request)
    let replay = try JSONDecoder().decode(PhoneRequest.self, from: bytes)
    #expect(replay.id == request.id)
    #expect(replay.workspaceID == workspace)

    let waiting = PhoneReceipt(requestID: request.id, outcome: .waiting, message: "Configure an agent.")
    #expect(!waiting.isSettled(at: 3))

    let applied = PhoneReceipt(requestID: request.id, outcome: .applied, revision: 2)
    #expect(!applied.isSettled(at: 1))
    #expect(applied.isSettled(at: 2))
}

@Test func queuedTicketsRetainCompletionCriteriaAndOlderRequestsStillDecode() throws {
    let request = PhoneRequest(workspaceID: UUID(), action: .create(
        projectID: "work", title: "Verify the handoff", notes: "Review the checklist.", priority: .high,
        sendToAgent: false, definitionOfDone: "Checklist reviewed and signed off."
    ))
    let data = try JSONEncoder().encode(request)
    let restored = try JSONDecoder().decode(PhoneRequest.self, from: data)
    guard case .create(_, _, _, _, _, let criteria, _, _, _, _, _, _) = restored.action else {
        Issue.record("The queued ticket did not decode as a creation request.")
        return
    }
    #expect(criteria == "Checklist reviewed and signed off.")

    let legacy = """
    {
      "id": "\(request.id.uuidString)",
      "workspaceID": "\(request.workspaceID.uuidString)",
      "createdAt": 0,
      "action": {"create": {
        "projectID": "work", "title": "Legacy task", "notes": "", "priority": "High", "sendToAgent": false
      }}
    }
    """
    let previous = try JSONDecoder().decode(PhoneRequest.self, from: Data(legacy.utf8))
    guard case .create(_, let title, _, _, _, let legacyCriteria, _, _, let legacyComment, let newProject, _, _) = previous.action else {
        Issue.record("The older creation request did not decode.")
        return
    }
    #expect(title == "Legacy task")
    #expect(legacyCriteria == nil)
    #expect(legacyComment == nil)
    #expect(newProject == nil)
}

#if DEBUG && os(macOS)
@MainActor
@Test func modelCatalogChangesSyncAtTheSameWorkspaceRevision() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let transport = LocalCompanionTransport(directory: directory)
    try await transport.prepare(account: transport.accountKey())
    let id = UUID()
    var cached = PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [], availableAgents: [.codex])
    try await transport.publish(cached)
    let example = AgentModelChoice(agent: .codex, id: "provider-next-model", title: "New Model")
    for catalog: [AgentModelChoice] in [[example], []] {
        try await transport.publish(PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [],
                                                  availableAgents: [.codex], agentModels: catalog))
        guard case .updated(let latest) = try await transport.snapshot(newerThan: cached) else {
            Issue.record("The phone did not receive the changed model catalog.")
            return
        }
        #expect(latest.agentModels == catalog)
        cached = latest
    }
}

@MainActor
@Test func upgradedMacEnablesEditingWithoutRequiringATaskChange() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let transport = LocalCompanionTransport(directory: directory)
    try await transport.prepare(account: transport.accountKey())

    let id = UUID()
    let previous = PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [], commentsByTask: [:])
    try await transport.publish(previous)
    let upgraded = PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [],
                                 commentsByTask: [:], supportsNoteEditing: true)
    try await transport.publish(upgraded)

    guard case .updated(let refreshed) = try await transport.snapshot(newerThan: previous) else {
        Issue.record("The phone did not see the capability change at the same workspace revision.")
        return
    }
    #expect(refreshed.supportsNoteEditing)
    #expect(!refreshed.supportsFieldEditing)

    let fieldEditing = PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [],
                                     commentsByTask: [:], supportsNoteEditing: true, supportsFieldEditing: true)
    try await transport.publish(fieldEditing)
    guard case .updated(let latest) = try await transport.snapshot(newerThan: refreshed) else {
        Issue.record("The phone did not see the ticket fields capability at the same revision.")
        return
    }
    #expect(latest.supportsFieldEditing)
}
#endif

@Test func urgentToDosLeadAndEachGroupIsNewestFirst() throws {
    let older = try #require(TaskCreationOrder.date(from: "2026-11-13T22:00:00Z"))
    let newer = try #require(TaskCreationOrder.date(from: "2026-11-14T01:00:00.123Z"))
    #expect(TaskCreationOrder.precedes(urgent: true, createdAt: older, otherUrgent: false, otherCreatedAt: newer) == true)
    #expect(TaskCreationOrder.precedes(urgent: true, createdAt: newer, otherUrgent: true, otherCreatedAt: older) == true)
    #expect(TaskCreationOrder.precedes(urgent: false, createdAt: older, otherUrgent: false, otherCreatedAt: newer) == false)
    #expect(TaskCreationOrder.precedes(urgent: false, createdAt: nil, otherUrgent: false, otherCreatedAt: newer) == false)
}

@Test func phoneDisplaysOnlyCanonicalTaskIDs() {
    let uuid = UUID().uuidString
    func ticket(_ key: String?) -> PhoneTask {
        PhoneTask(id: uuid, projectID: "jotley", title: "Check task ID", notes: "", definitionOfDone: "",
                  status: .todo, priority: .medium, dueDate: nil, revision: 1, assigned: false, taskKey: key)
    }
    #expect(ticket("JOT-004").displayTaskID == "JOT-004")
    #expect(ticket("ink-1").displayTaskID == "INK-001")
    #expect(ticket("int-1435").displayTaskID == "INT-1435")
    #expect(ticket(nil).displayTaskID == nil)
    #expect(ticket(uuid).displayTaskID == nil)
}

@Test func quickAddRoutesNamedProjectsAndDefaultsToPersonalAndMedium() {
    let studio = PhoneProject(id: "studio", name: "Studio Launch")
    let personal = PhoneProject(id: "personal", name: "Personal")
    let projects = [studio, personal]
    let named = TaskDrafting.captureDestination(in: "For project studio launch verify the download button.",
                                               projects: projects, suggestedName: nil)
    #expect(named.projectID == studio.id)
    #expect(named.newProjectName == nil)

    let newProject = TaskDrafting.captureDestination(in: "For a new project called Harbor Launch, write the brief.",
                                                     projects: projects, suggestedName: studio.name)
    #expect(newProject.newProjectName == "Harbor Launch")

    let fallback = TaskDrafting.captureDestination(in: "Call the plumber.", projects: projects, suggestedName: studio.name)
    #expect(fallback.projectID == personal.id)
    let missingPersonal = TaskDrafting.captureDestination(in: "Call the plumber.", projects: [studio], suggestedName: nil)
    #expect(missingPersonal.newProjectName == "Personal")

    #expect(TaskDrafting.capturePriority(in: "Make this a critical task.") == .urgent)
    #expect(TaskDrafting.capturePriority(in: "Set this task as high priority.") == .high)
    #expect(TaskDrafting.capturePriority(in: "Call the plumber.") == .medium)
}

#if DEBUG && os(macOS)
@MainActor
@Test func agentAvailabilityRefreshesWithoutATaskChange() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let transport = LocalCompanionTransport(directory: directory)
    try await transport.prepare(account: transport.accountKey())
    let id = UUID()
    var cached = PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [],
                               includesCardMetadata: true)
    try await transport.publish(cached)
    for agents: [PhoneAgent] in [[.codex], [.codex, .claude], []] {
        try await transport.publish(PhoneSnapshot(workspaceID: id, revision: 7, projects: [], tasks: [],
                                                  includesCardMetadata: true, availableAgents: agents))
        guard case .updated(let latest) = try await transport.snapshot(newerThan: cached) else {
            Issue.record("The phone did not receive updated agent availability.")
            return
        }
        #expect(latest.availableAgents == agents)
        cached = latest
    }
}

@MainActor
@Test func sameRevisionSnapshotRefreshAddsCardMetadata() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let transport = LocalCompanionTransport(directory: directory)
    try await transport.prepare(account: transport.accountKey())
    let workspaceID = UUID()
    let legacyTask = PhoneTask(id: "test", projectID: "project", title: "Task", notes: "", definitionOfDone: "",
                              status: .todo, priority: .urgent, dueDate: nil, revision: 7, assigned: false)
    let legacy = PhoneSnapshot(workspaceID: workspaceID, revision: 7, projects: [], tasks: [legacyTask],
                               supportsFieldEditing: true)
    try await transport.publish(legacy)
    guard case .updated(let cached) = try await transport.snapshot(newerThan: nil) else {
        Issue.record("The old snapshot did not decode.")
        return
    }
    #expect(cached.tasks.first?.createdAt == nil)
    #expect(cached.tasks.first?.position == nil)
    #expect(!cached.supportsTaskReordering)
    let createdAt = Date(timeIntervalSinceReferenceDate: 123)
    let newTask = PhoneTask(id: "test", projectID: "project", title: "Task", notes: "", definitionOfDone: "",
                            status: .todo, priority: .urgent, dueDate: nil, revision: 7, assigned: false,
                            taskKey: "PRO-001", createdAt: createdAt)
    let upgraded = PhoneSnapshot(workspaceID: workspaceID, revision: 7, projects: [], tasks: [newTask],
                                 supportsFieldEditing: true, includesCardMetadata: true)
    try await transport.publish(upgraded)
    guard case .updated(let refreshed) = try await transport.snapshot(newerThan: cached) else {
        Issue.record("An unchanged workspace revision suppressed the new metadata.")
        return
    }
    #expect(refreshed.tasks.first?.taskKey == "PRO-001")
    #expect(refreshed.tasks.first?.createdAt == createdAt)
    let positioned = PhoneTask(id: "test", projectID: "project", title: "Task", notes: "", definitionOfDone: "",
                               status: .todo, priority: .urgent, dueDate: nil, revision: 7, assigned: false,
                               taskKey: "PRO-001", createdAt: createdAt, position: 2)
    let withOrder = PhoneSnapshot(workspaceID: workspaceID, revision: 7, projects: [], tasks: [positioned],
                                  supportsFieldEditing: true, includesCardMetadata: true, supportsTaskReordering: true)
    try await transport.publish(withOrder)
    guard case .updated(let current) = try await transport.snapshot(newerThan: refreshed) else {
        Issue.record("The phone did not receive manual positions when the Mac was upgraded.")
        return
    }
    #expect(current.tasks.first?.position == 2)
    #expect(current.supportsTaskReordering)
    #expect(current.tasks.first?.completedAt == nil)
    let completedAt = Date(timeIntervalSinceReferenceDate: 456)
    let done = PhoneTask(id: "test", projectID: "project", title: "Task", notes: "", definitionOfDone: "",
                         status: .done, priority: .urgent, dueDate: nil, revision: 7, assigned: false,
                         createdAt: createdAt, completedAt: completedAt)
    let withCompletionDate = PhoneSnapshot(workspaceID: workspaceID, revision: 7, projects: [], tasks: [done],
                                           supportsTaskReordering: true, includesCompletionDates: true)
    try await transport.publish(withCompletionDate)
    guard case .updated(let completed) = try await transport.snapshot(newerThan: current) else {
        Issue.record("An unchanged workspace revision suppressed recorded completion dates.")
        return
    }
    #expect(completed.tasks.first?.completedAt == completedAt)
}
#endif

@Test func bugInferenceRequiresAnExplicitBugIntent() throws {
    #expect(IssueType.inferred(from: "Create a critical bug for the frozen task menu") == .bug)
    #expect(IssueType.inferred(from: "Bug: due date cannot change") == .bug)
    #expect(IssueType.inferred(from: "Buy bug spray") == .issue)
    #expect(IssueType.inferred(from: "Write a release checklist") == .issue)
}

@Test func revisionHistoryRoundTripsAndNeverReplaysDispatch() throws {
    let data = Data(##"{"taskID":"task","revision":12,"entries":[{"id":"entry","version":3,"savedAt":"2026-11-19T12:00:00Z","action":"update_task","origin":"Mobile app","changedFields":["notes"],"state":{"title":"A bug","notes":"Original notes","definitionOfDone":"Test it","planMarkdown":"# Plan","issueType":"Bug","projectID":"project","projectName":"Studio","taskKey":"STU-001","status":"Sent to agent","priority":"High","dueDate":null,"position":0,"archived":false,"trashed":false}}],"nextBefore":3}"##.utf8)
    let page = try JSONDecoder().decode(TaskHistoryPage.self, from: data)
    #expect(page.entries[0].state.restoredStatus == .todo)
    #expect(page.entries[0].state.issueType == .bug)
    #expect(page.entries[0].summary == "Notes")
    #expect(try JSONDecoder().decode(TaskHistoryPage.self, from: JSONEncoder().encode(page)) == page)
    let request = PhoneRequest(workspaceID: UUID(), action: .restoreRevision(taskID: "task", historyID: "entry", revision: 12))
    #expect(request.changesTask)
    #expect(request.taskID == "task")
    let load = PhoneRequest(workspaceID: request.workspaceID, action: .loadHistory(taskID: "task", beforeVersion: 3))
    #expect(!load.changesTask)
    let receipt = PhoneReceipt(requestID: load.id, outcome: .applied, revision: 12, history: page)
    #expect(try JSONDecoder().decode(PhoneReceipt.self, from: JSONEncoder().encode(receipt)) == receipt)
    let ended = try JSONDecoder().decode(TaskHistoryPage.self, from: Data(##"{"taskID":"task","revision":12,"entries":[],"nextBefore":null}"##.utf8))
    #expect(page.merging(ended).nextBefore == nil)
    #expect(page.merging(page).entries.count == 1)
}

@Test func activityPagesRoundTripKeepContinuousHistoryAndDiscardGaps() throws {
    func entry(_ n: Int, kind: String = "change") -> TaskActivityEntry {
        TaskActivityEntry(id: String(n), sequence: n, createdAt: "2026-11-19T15:00:00Z", actor: "You", kind: kind, summary: "Changed task", detail: "To do → In progress", images: [])
    }
    let older = TaskActivityPage(taskID: "task", revision: 9, entries: (1...5).reversed().map { entry($0) }, nextBefore: nil)
    let current = TaskActivityPage(taskID: "task", revision: 10, entries: (5...9).reversed().map { entry($0) }, nextBefore: 5)
    let merged = current.keepingOlder(from: older)
    #expect(merged.entries.map(\.sequence) == Array((1...9).reversed()))
    #expect(merged.nextBefore == nil)
    let gap = TaskActivityPage(taskID: "task", revision: 20, entries: [entry(20), entry(19)], nextBefore: 19)
    #expect(gap.keepingOlder(from: merged) == gap)
    let restored = TaskActivityPage(taskID: "task", revision: 11, entries: [entry(10, kind: "restore"), entry(9)], nextBefore: 9)
    #expect(restored.keepingOlder(from: merged) == restored)
    let request = PhoneRequest(workspaceID: UUID(), action: .loadActivity(taskID: "task", beforeSequence: 5))
    #expect(!request.changesTask)
    #expect(try JSONDecoder().decode(PhoneRequest.self, from: JSONEncoder().encode(request)).taskID == "task")
    let receipt = PhoneReceipt(requestID: request.id, outcome: .applied, revision: 10, activity: merged)
    #expect(try JSONDecoder().decode(PhoneReceipt.self, from: JSONEncoder().encode(receipt)).activity == merged)
    let old = PhoneSnapshot(workspaceID: request.workspaceID, revision: 10, projects: [], tasks: [])
    let updated = PhoneSnapshot(workspaceID: request.workspaceID, revision: 10, projects: [], tasks: [], activityByTask: ["task": current])
    #expect(updated.shouldReplace(old))
    #expect(try JSONDecoder().decode(PhoneSnapshot.self, from: JSONEncoder().encode(old)).activityByTask == nil)
}

@Test func commentsHideUnknownLegacyAuthorsAndDoNotTreatPickupAsActedOn() throws {
    let old = try JSONDecoder().decode(PhoneComment.self, from: Data(#"{"id":"legacy","text":"Agent report","createdAt":"2026-11-19T12:00:00Z","delivery":"delivered","pickedUpAt":"2026-11-19T12:01:00Z"}"#.utf8))
    #expect(!old.isUserComment(hasSeparatedActivity: false))
    #expect(old.isUserComment(hasSeparatedActivity: true)) // v18 Mac already filtered this stream.
    #expect(!old.wasActedOn)
    let user = PhoneComment(id: "user", text: "Change the date", createdAt: "2026-11-19T12:00:00Z", source: "user", actedOnAt: "2026-11-19T12:02:00Z", activityID: "report")
    #expect(user.isUserComment(hasSeparatedActivity: false))
    #expect(user.wasActedOn)
    let legacy = PhoneComment(id: "other", text: "Earlier message", createdAt: "2026-11-19T12:00:00Z", source: "legacy")
    #expect(!legacy.isUserComment(hasSeparatedActivity: true))
    let workspace = UUID()
    let previous = PhoneSnapshot(workspaceID: workspace, revision: 8, projects: [], tasks: [], activityByTask: [:])
    let current = PhoneSnapshot(workspaceID: workspace, revision: 8, projects: [], tasks: [], activityByTask: [:], supportsCommentActivity: true)
    #expect(current.shouldReplace(previous))
    let request = PhoneRequest(workspaceID: workspace, action: .loadCommentActivity(taskID: "task", commentID: "user", beforeSequence: nil))
    #expect(!request.changesTask)
    #expect(try JSONDecoder().decode(PhoneRequest.self, from: JSONEncoder().encode(request)).taskID == "task")
    let taskPage = TaskActivityPage(taskID: "task", revision: 8, entries: [], nextBefore: nil)
    let commentPage = TaskActivityPage(taskID: "task", revision: 8, entries: [], nextBefore: nil, commentID: "user")
    #expect(taskPage.merging(commentPage) == taskPage)
    #expect(try JSONDecoder().decode(TaskActivityPage.self, from: JSONEncoder().encode(commentPage)).commentID == "user")
}

@Test func openFeedUsesCreationOrderUnlessAnotherSortIsSelected() {
    struct Task: Identifiable {
        let id: String
        let created: Date?
        let rank: Int
        let due: String?
    }
    let tasks = [
        Task(id: "legacy", created: nil, rank: 0, due: nil),
        Task(id: "urgent", created: .distantPast.addingTimeInterval(1), rank: 0, due: "2026-12-02"),
        Task(id: "new", created: .now, rank: 4, due: "2026-12-01")
    ]
    func ids(_ sort: OpenTaskSort) -> [String] {
        sort.ordered(tasks, created: \.created, priorityRank: \.rank, due: \.due).map(\.id)
    }
    #expect(ids(.newest) == ["new", "urgent", "legacy"])
    #expect(ids(.priority) == ["urgent", "legacy", "new"])
    #expect(ids(.dueDate) == ["new", "urgent", "legacy"])
}

@Test func geminiReachesCurrentAppsWithoutBreakingEarlierOnes() throws {
    // The agent contract shipped before Gemini. An unknown agent anywhere in it fails the whole snapshot.
    struct EarlierSnapshot: Decodable {
        enum Agent: String, Decodable { case claude = "claude-code", codex }
        struct Model: Decodable { let agent: Agent; let id: String }
        let defaultAgent: Agent?
        let availableAgents: [Agent]?
        let agentModels: [Model]?
    }
    let models = [
        AgentModelChoice(agent: .codex, id: "gpt-6.2-sol", title: "GPT-6.2 Sol"),
        AgentModelChoice(agent: .gemini, id: "gemini-4-hydrogen-high", title: "Gemini 4 Hydrogen"),
    ]
    let id = UUID()
    let snapshot = PhoneSnapshot(workspaceID: id, revision: 3, projects: [], tasks: [], defaultAgent: .gemini,
                                 availableAgents: [.claude, .codex, .gemini], agentModels: models)
    let data = try JSONEncoder().encode(snapshot)

    let earlier = try JSONDecoder().decode(EarlierSnapshot.self, from: data)
    #expect(earlier.defaultAgent == nil)
    #expect(earlier.availableAgents == [.claude, .codex])
    #expect(earlier.agentModels?.map(\.id) == ["gpt-6.2-sol"])

    let current = try JSONDecoder().decode(PhoneSnapshot.self, from: data)
    #expect(current.agents.defaultAgent == .gemini)
    #expect(current.agents.availableAgents == [.claude, .codex, .gemini])
    #expect(current.agents.agentModels == models)
    #expect(PhoneAgent.gemini.title == "Gemini")
    #expect(PhoneTaskFieldEdit.status(.sent, agent: .gemini).label == "Send to Gemini")
    // Gemini's Agent default names the model it sends. Claude and Codex choose their own.
    #expect(PhoneAgent.gemini.agentDefaultTitle(models: models) == "Agent default (Gemini 4 Hydrogen)")
    #expect(PhoneAgent.gemini.agentDefaultTitle(models: [models[0]]) == "Agent default")
    #expect(PhoneAgent.codex.agentDefaultTitle(models: models) == "Agent default")

    // A Mac that has not been updated sends only the earlier fields.
    let olderMac = try JSONDecoder().decode(PhoneSnapshot.self, from: Data("""
        {"version":1,"workspaceID":"\(id.uuidString)","revision":3,"updatedAt":0,"projects":[],"tasks":[],
         "defaultAgent":"codex","availableAgents":["codex"],"agentModels":[{"agent":"codex","id":"gpt-6.2-sol","title":"Sol"}]}
        """.utf8))
    #expect(olderMac.agents.defaultAgent == .codex)
    #expect(olderMac.agents.availableAgents == [.codex])
    // Gemini becoming available replaces a stored snapshot at the same task revision.
    let withoutGemini = PhoneSnapshot(workspaceID: id, revision: 3, projects: [], tasks: [], defaultAgent: .codex,
                                      availableAgents: [.codex], agentModels: [models[0]])
    #expect(snapshot.shouldReplace(withoutGemini))
    #expect(snapshot.shouldReplace(olderMac))
    #expect(!snapshot.shouldReplace(snapshot))
}

private func withdrawalSnapshot(workspace: UUID, supported: Bool, comments: [PhoneComment] = []) -> PhoneSnapshot {
    PhoneSnapshot(workspaceID: workspace, revision: 4, projects: [], tasks: [],
                  commentsByTask: ["task-1": comments], supportsCommentActivity: true,
                  filesByTask: [:], supportsRevisionWithdrawal: supported)
}

@Test func withdrawalRequestsRoundTripAndOlderMacsNeverReceiveThem() throws {
    let workspace = UUID()
    let withdrawal = PhoneRequest(workspaceID: workspace, action: .withdrawComment(taskID: "task-1", commentID: "abc"))
    let restored = try JSONDecoder().decode(PhoneRequest.self, from: JSONEncoder().encode(withdrawal))
    #expect(restored.id == withdrawal.id)
    #expect(restored.taskID == "task-1")
    #expect(restored.withdrawnRevisionID == "abc")
    #expect(!restored.changesTask)

    // A Mac that predates withdrawal publishes no capability, and its snapshot still decodes.
    let older = withdrawalSnapshot(workspace: workspace, supported: false)
    let current = withdrawalSnapshot(workspace: workspace, supported: true)
    let decoded = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONEncoder().encode(older))
    #expect(!decoded.supportsRevisionWithdrawal)
    #expect(try JSONDecoder().decode(PhoneSnapshot.self, from: JSONEncoder().encode(current)).supportsRevisionWithdrawal)
    // The upgraded Mac republishes at the same workspace revision so phones learn the capability.
    #expect(current.projectionVersion == 24)
    #expect(current.shouldReplace(older))
    #expect(!older.shouldReplace(current))

    let comment = PhoneRequest(workspaceID: workspace, action: .comment(taskID: "task-1", text: "Offered to iCloud"))
    #expect(throws: RevisionWithdrawal.Failure.updateMac) {
        try RevisionWithdrawal.plan(revisionID: comment.revisionID!, taskID: "task-1", pending: [comment],
                                    unsent: [], snapshot: older)
    }
    // A request that never left the phone needs no Mac support at all.
    #expect(try RevisionWithdrawal.plan(revisionID: comment.revisionID!, taskID: "task-1", pending: [comment],
                                        unsent: [comment.id], snapshot: older) == .discard(requestID: comment.id))
}

@Test func withdrawalPlansUseTheStableIDAndStayInsideTheTaskAndWorkspace() throws {
    let workspace = UUID()
    let queued = PhoneRequest(workspaceID: workspace, action: .comment(taskID: "task-1", text: "Queued here"))
    let stable = try #require(queued.revisionID)
    #expect(stable == queued.id.uuidString.lowercased())
    let saved = PhoneComment(id: "saved-1", text: "Waiting", createdAt: "2026-11-23T10:00:00Z", delivery: "queued", source: "user")
    let received = PhoneComment(id: "saved-2", text: "With the agent", createdAt: "2026-11-23T10:00:00Z", delivery: "delivered",
                                pickedUpAt: "2026-11-23T10:01:00Z", source: "user")
    let acted = PhoneComment(id: "saved-3", text: "Applied", createdAt: "2026-11-23T10:00:00Z", delivery: "delivered",
                             source: "user", actedOnAt: "2026-11-23T10:05:00Z", activityID: "activity-1")
    let legacy = PhoneComment(id: "saved-4", text: "Agent note", createdAt: "2026-11-23T10:00:00Z", delivery: "local", source: "legacy")
    let snapshot = withdrawalSnapshot(workspace: workspace, supported: true, comments: [saved, received, acted, legacy])

    #expect(try RevisionWithdrawal.plan(revisionID: stable, taskID: "task-1", pending: [queued], unsent: [],
                                        snapshot: snapshot) == .request(commentID: stable))
    #expect(try RevisionWithdrawal.plan(revisionID: "saved-1", taskID: "task-1", pending: [], unsent: [],
                                        snapshot: snapshot) == .request(commentID: "saved-1"))
    // A request the agent holds but has not acted on can still be withdrawn. Applied work cannot.
    #expect(received.reachedAgent && received.canWithdraw)
    #expect(try RevisionWithdrawal.plan(revisionID: "saved-2", taskID: "task-1", pending: [], unsent: [],
                                        snapshot: snapshot) == .request(commentID: "saved-2"))
    #expect(throws: RevisionWithdrawal.Failure.alreadyActedOn) {
        try RevisionWithdrawal.plan(revisionID: "saved-3", taskID: "task-1", pending: [], unsent: [], snapshot: snapshot)
    }
    #expect(!RevisionWithdrawal.isOffered(for: acted, in: snapshot))
    #expect(!RevisionWithdrawal.isOffered(for: legacy, in: snapshot))
    #expect(RevisionWithdrawal.isOffered(for: saved, in: snapshot))
    #expect(!RevisionWithdrawal.isOffered(for: saved, in: withdrawalSnapshot(workspace: workspace, supported: false)))

    // Another task or another workspace never matches.
    #expect(throws: RevisionWithdrawal.Failure.missing) {
        try RevisionWithdrawal.plan(revisionID: "saved-1", taskID: "task-2", pending: [], unsent: [], snapshot: snapshot)
    }
    #expect(throws: RevisionWithdrawal.Failure.missing) {
        try RevisionWithdrawal.plan(revisionID: stable, taskID: "task-2", pending: [queued], unsent: [queued.id], snapshot: snapshot)
    }
    let elsewhere = PhoneRequest(workspaceID: UUID(), action: .comment(taskID: "task-1", text: "Other workspace"))
    #expect(throws: RevisionWithdrawal.Failure.missing) {
        try RevisionWithdrawal.plan(revisionID: elsewhere.revisionID!, taskID: "task-1", pending: [elsewhere],
                                    unsent: [elsewhere.id], snapshot: snapshot)
    }
}

@Test func withdrawnRequestsSettleQuietlyAndStayHiddenUntilBothRequestsLeaveTheQueue() {
    let workspace = UUID()
    let comment = PhoneRequest(workspaceID: workspace, action: .comment(taskID: "task-1", text: "Changed my mind"))
    let stable = comment.revisionID!
    let withdrawal = PhoneRequest(workspaceID: workspace, action: .withdrawComment(taskID: "task-1", commentID: stable))
    let other = PhoneRequest(workspaceID: workspace, action: .comment(taskID: "task-1", text: "Still wanted"))

    #expect(RevisionWithdrawal.hidesRejection(of: comment, withdrawing: [stable]))
    #expect(!RevisionWithdrawal.hidesRejection(of: other, withdrawing: [stable]))
    #expect(!RevisionWithdrawal.hidesRejection(of: withdrawal, withdrawing: [stable]), "A refused withdrawal is reported")
    #expect(RevisionWithdrawal.stillWithdrawing([stable], pending: [comment, withdrawal, other]) == [stable])
    #expect(RevisionWithdrawal.stillWithdrawing([stable], pending: [comment, other]) == [stable])
    #expect(RevisionWithdrawal.stillWithdrawing([stable], pending: [other]).isEmpty)
}

#if DEBUG && os(macOS)
@MainActor
@Test func theMacAppliesAWithdrawalBeforeTheRequestItCancelsAndKeepsEachReceipt() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "opentalon-withdraw-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let transport = LocalCompanionTransport(directory: directory)
    try await transport.prepare(account: try await transport.accountKey())
    let workspace = UUID()
    try await transport.publish(withdrawalSnapshot(workspace: workspace, supported: true))

    // The phone queued a request offline, then withdrew it. Both reach iCloud in one pass.
    let comment = PhoneRequest(workspaceID: workspace, action: .comment(taskID: "task-1", text: "Queued offline"))
    let edit = PhoneRequest(workspaceID: workspace, action: .forceComplete(taskID: "task-2"))
    let withdrawal = PhoneRequest(workspaceID: workspace,
                                  action: .withdrawComment(taskID: "task-1", commentID: comment.revisionID!))
    for request in [comment, edit, withdrawal] { #expect(try await transport.submit(request) == nil) }

    let ordered = PhoneRequest.applicationOrder(try await transport.pendingRequests(for: workspace))
    #expect(ordered.map(\.id) == [withdrawal.id, comment.id, edit.id])

    // The Mac records the withdrawal, then turns the late request away. Each keeps its own receipt on retry.
    try await transport.acknowledge(PhoneReceipt(requestID: withdrawal.id, outcome: .applied, revision: 5))
    try await transport.acknowledge(PhoneReceipt(requestID: comment.id, outcome: .rejected,
                                                 message: "This revision request was withdrawn before it reached your Mac."))
    #expect(try await transport.pendingRequests(for: workspace).map(\.id) == [edit.id])
    #expect(try await transport.submit(withdrawal)?.outcome == .applied)
    let refused = try #require(try await transport.submit(comment))
    #expect(refused.outcome == .rejected)
    #expect(refused.isSettled(at: 4))
    #expect(RevisionWithdrawal.hidesRejection(of: comment, withdrawing: [comment.revisionID!]))
}
#endif
