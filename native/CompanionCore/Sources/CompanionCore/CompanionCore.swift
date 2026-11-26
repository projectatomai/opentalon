import Foundation

public enum TaskReference {
    public static func normalized(in text: String) -> String? {
        guard let range = text.range(of: #"(?i)(?<![\p{L}\p{N}‐‑–—-])[a-z]{3}[-‐‑–—][0-9]{1,16}(?![\p{L}\p{N}‐‑–—-])"#,
                                     options: .regularExpression) else { return nil }
        let key = String(text[range]).uppercased()
        let digits = key.dropFirst(4).drop(while: { $0 == "0" })
        let number = digits.isEmpty ? "0" : String(digits)
        return String(key.prefix(3)) + "-" + String(repeating: "0", count: max(0, 3 - number.count)) + number
    }
}

public enum TaskCreationOrder {
    public static func date(from value: String) -> Date? {
        // Value-style parsing avoids constructing ICU formatters while sorting cards.
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)) ??
            (try? Date.ISO8601FormatStyle().parse(value))
    }

    public static func precedes(urgent: Bool, createdAt: Date?, otherUrgent: Bool, otherCreatedAt: Date?) -> Bool? {
        if urgent != otherUrgent { return urgent }
        let date = createdAt ?? .distantPast
        let otherDate = otherCreatedAt ?? .distantPast
        return date == otherDate ? nil : date > otherDate
    }
}

public enum OpenTaskSort: String, CaseIterable, Sendable {
    case newest = "Newest first", priority = "Priority", dueDate = "Due date"

    public func ordered<Item: Identifiable>(_ tasks: [Item], created: (Item) -> Date?,
                                            priorityRank: (Item) -> Int, due: (Item) -> String?) -> [Item]
        where Item.ID == String {
        tasks.map { (item: $0, created: created($0) ?? .distantPast,
                     rank: self == .priority ? priorityRank($0) : 0,
                     due: self == .dueDate ? due($0) : nil) }
            .sorted { lhs, rhs in
                if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
                if lhs.due != rhs.due {
                    guard let first = lhs.due else { return false }
                    guard let second = rhs.due else { return true }
                    return first < second
                }
                if lhs.created != rhs.created { return lhs.created > rhs.created }
                return lhs.item.id > rhs.item.id
            }
            .map(\.item)
    }
}

public enum DoneOrder: String, CaseIterable, Codable, Identifiable, Sendable {
    case recent, oldest, manual

    public var id: Self { self }

    public var title: String {
        switch self {
        case .recent: "Recently completed"
        case .oldest: "Oldest completed"
        case .manual: "Manual order"
        }
    }

    public func ordered<Item: Identifiable>(_ items: [Item], completionDate: (Item) -> Date?,
                                            creationDate: (Item) -> Date?) -> [Item] where Item.ID == String {
        guard self != .manual else { return items }
        return items.map { (item: $0, completion: completionDate($0), creation: creationDate($0)) }
            .sorted { left, right in
                if (left.completion != nil) != (right.completion != nil) { return left.completion != nil }
                let first = left.completion ?? left.creation
                let second = right.completion ?? right.creation
                if let first, let second, first != second { return self == .recent ? first > second : first < second }
                if (first != nil) != (second != nil) { return first != nil }
                return left.item.id < right.item.id
            }
            .map(\.item)
    }
}

public struct PhoneProject: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let createdAt: Date?

    public init(id: String, name: String, createdAt: Date? = nil) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
    }
}

public struct PhoneComment: Codable, Identifiable, Sendable {
    public let id: String
    public let text: String
    public let createdAt: String
    public let delivery: String?
    public let pickedUpAt: String?
    public let source: String?
    public let actedOnAt: String?
    public let activityID: String?
    public let activityState: String?

    public init(id: String, text: String, createdAt: String, delivery: String? = nil, pickedUpAt: String? = nil,
                source: String? = nil, actedOnAt: String? = nil, activityID: String? = nil, activityState: String? = nil) {
        self.id=id; self.text=text; self.createdAt=createdAt; self.delivery=delivery; self.pickedUpAt=pickedUpAt
        self.source=source; self.actedOnAt=actedOnAt; self.activityID=activityID; self.activityState=activityState
    }
    public func isUserComment(hasSeparatedActivity: Bool) -> Bool {
        source == "user" || (source == nil && hasSeparatedActivity)
    }
    public var wasActedOn: Bool { actedOnAt != nil && activityID != nil }
    /// The agent has this request, or is about to. Withdrawing then asks its run to skip it.
    public var reachedAgent: Bool { pickedUpAt != nil || delivery == "delivered" }
    /// A request stays the user's to withdraw until an agent has acted on it.
    public var canWithdraw: Bool { source == "user" && actedOnAt == nil }
}

public struct PhoneAgentPickup: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let at: Date

    public init(id: String, at: Date) {
        self.id = id
        self.at = at
    }
}

public enum PhoneAgent: String, Codable, CaseIterable, Identifiable, Sendable {
    case claude = "claude-code", codex, gemini
    public var id: Self { self }
    public var title: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .gemini: "Gemini"
        }
    }
    /// Apps released before Gemini cannot decode it, so it never goes in the fields they read.
    var readableByEarlierApps: Bool { self != .gemini }

    /// Claude and Codex pick their own model for Agent default. Gemini is sent the first model in its list.
    public func agentDefaultTitle(models: [AgentModelChoice]) -> String {
        guard self == .gemini, let model = models.first(where: { $0.agent == self }) else { return "Agent default" }
        return "Agent default (\(model.title))"
    }
}

/// Every agent the Mac offers, including ones earlier apps cannot decode.
public struct PhoneAgentChoices: Codable, Equatable, Sendable {
    public let defaultAgent: PhoneAgent?
    public let availableAgents: [PhoneAgent]?
    public let agentModels: [AgentModelChoice]?
}

public struct PhoneTask: Codable, Identifiable, Sendable {
    public enum Status: String, CaseIterable, Codable, Sendable {
        case todo = "To do", sent = "Sent to agent", working = "In progress", done = "Done"
    }

    public enum Priority: String, CaseIterable, Codable, Identifiable, Sendable {
        case urgent = "Urgent", high = "High", medium = "Medium", low = "Low", none = "None"
        public var id: Self { self }
        public var title: String { self == .none ? "No priority" : rawValue }
        public var rank: Int { Self.allCases.firstIndex(of: self) ?? 4 }
    }

    public let id: String
    public let projectID: String
    public let title: String
    public let notes: String
    public let planMarkdown: String?
    public let issueType: IssueType?
    public var kind: IssueType { issueType ?? .issue }
    public let definitionOfDone: String
    public let status: Status
    public let priority: Priority
    public let dueDate: String?
    public let revision: Int
    public let assigned: Bool
    public let taskKey: String?
    public let createdAt: Date?
    public let updatedAt: Date?
    public let completedAt: Date?
    public let archivedAt: Date?
    public let agentPickup: PhoneAgentPickup?
    public let agentDispatchError: String?
    public let position: Int?

    public init(id: String, projectID: String, title: String, notes: String, definitionOfDone: String,
                status: Status, priority: Priority, dueDate: String?, revision: Int, assigned: Bool,
                taskKey: String? = nil, createdAt: Date? = nil, archivedAt: Date? = nil,
                agentPickup: PhoneAgentPickup? = nil, agentDispatchError: String? = nil,
                position: Int? = nil, planMarkdown: String? = nil, issueType: IssueType? = nil,
                completedAt: Date? = nil, updatedAt: Date? = nil) {
        self.id = id
        self.projectID = projectID
        self.title = title
        self.notes = notes
        self.planMarkdown = planMarkdown
        self.issueType = issueType
        self.definitionOfDone = definitionOfDone
        self.status = status
        self.priority = priority
        self.dueDate = dueDate
        self.revision = revision
        self.assigned = assigned
        self.taskKey = taskKey
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.archivedAt = archivedAt
        self.agentPickup = agentPickup
        self.agentDispatchError = agentDispatchError
        self.position = position
    }

    public var isManualOpen: Bool { !assigned && (status == .todo || status == .working) }

    public var displayTaskID: String? {
        guard let key = taskKey?.uppercased(),
              key.range(of: #"\A[A-Z]{3}-[0-9]{1,16}\z"#, options: .regularExpression) != nil else {
            return nil
        }
        let digits = key.dropFirst(4)
        return String(key.prefix(4)) + String(repeating: "0", count: max(0, 3 - digits.count)) + String(digits)
    }
}

public struct PhoneTrashedTask: Codable, Identifiable, Sendable {
    public let id: String
    public let projectID: String
    public let title: String
    public let revision: Int
    public let updatedAt: Date?
    public let deletedAt: Date?

    public init(id: String, projectID: String, title: String, revision: Int,
                updatedAt: Date? = nil, deletedAt: Date? = nil) {
        self.id = id
        self.projectID = projectID
        self.title = title
        self.revision = revision
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
}

public struct AgentModelChoice: Codable, Equatable, Identifiable, Sendable {
    public let agent: PhoneAgent
    public let id: String
    public let title: String

    public init(agent: PhoneAgent, id: String, title: String) {
        self.agent = agent
        self.id = id
        self.title = title
    }
}

public struct PhoneSnapshot: Codable, Sendable {
    public let version: Int
    public let workspaceID: UUID
    public let revision: Int
    public let updatedAt: Date
    public let projects: [PhoneProject]
    public let tasks: [PhoneTask]
    // These three keep to the agents every released app can decode. `agentChoices` has them all.
    public let defaultAgent: PhoneAgent?
    public let availableAgents: [PhoneAgent]?
    public let agentModels: [AgentModelChoice]?
    private let agentChoices: PhoneAgentChoices?
    public let agentConnectionReady: Bool?
    public let commentsByTask: [String: [PhoneComment]]?
    public let filesByTask: [String: [TaskFile]]?
    public let trashedTasks: [PhoneTrashedTask]?
    public let captureProjectID: String?
    public let macName: String?
    private let noteEditing: Bool?
    private let fieldEditing: Bool?
    private let cardMetadata: Bool?
    private let dispatchComments: Bool?
    private let taskOverrides: Bool?
    private let bulkArchive: Bool?
    private let taskReordering: Bool?
    private let taskOrganization: Bool?
    private let taskPlans: Bool?
    private let taskTypes: Bool?
    private let commentActivity: Bool?
    private let completionDates: Bool?
    private let taskUpdateDates: Bool?
    private let revisionWithdrawal: Bool?
    public let historyByTask: [String: TaskHistoryPage]?
    public let activityByTask: [String: TaskActivityPage]?

    public init(workspaceID: UUID, revision: Int, updatedAt: Date = .now,
                projects: [PhoneProject], tasks: [PhoneTask], defaultAgent: PhoneAgent? = nil,
                commentsByTask: [String: [PhoneComment]]? = nil, supportsNoteEditing: Bool = false,
                supportsFieldEditing: Bool = false, includesCardMetadata: Bool = false,
                availableAgents: [PhoneAgent]? = nil, agentModels: [AgentModelChoice]? = nil,
                supportsDispatchComments: Bool = false, trashedTasks: [PhoneTrashedTask]? = nil,
                captureProjectID: String? = nil, macName: String? = nil,
                supportsTaskOverrides: Bool = false, supportsBulkArchive: Bool = false,
                supportsTaskReordering: Bool = false, supportsTaskOrganization: Bool = false,
                supportsTaskPlans: Bool = false, supportsTaskTypes: Bool = false, historyByTask: [String: TaskHistoryPage]? = nil, activityByTask: [String: TaskActivityPage]? = nil, supportsCommentActivity: Bool = false,
                includesCompletionDates: Bool = false, agentConnectionReady: Bool? = nil,
                includesTaskUpdateDates: Bool = false, filesByTask: [String: [TaskFile]]? = nil,
                supportsRevisionWithdrawal: Bool = false) {
        version = 1
        self.workspaceID = workspaceID
        self.revision = revision
        self.updatedAt = updatedAt
        self.projects = projects
        self.tasks = tasks
        self.defaultAgent = defaultAgent.flatMap { $0.readableByEarlierApps ? $0 : nil }
        self.availableAgents = availableAgents?.filter(\.readableByEarlierApps)
        self.agentModels = agentModels?.filter(\.agent.readableByEarlierApps)
        agentChoices = availableAgents == nil && agentModels == nil ? nil
            : PhoneAgentChoices(defaultAgent: defaultAgent, availableAgents: availableAgents, agentModels: agentModels)
        self.agentConnectionReady = agentConnectionReady
        self.commentsByTask = commentsByTask
        self.filesByTask = filesByTask
        self.trashedTasks = trashedTasks
        self.captureProjectID = captureProjectID
        self.macName = macName
        noteEditing = supportsNoteEditing ? true : nil
        fieldEditing = supportsFieldEditing ? true : nil
        cardMetadata = includesCardMetadata ? true : nil
        dispatchComments = supportsDispatchComments ? true : nil
        taskOverrides = supportsTaskOverrides ? true : nil
        bulkArchive = supportsBulkArchive ? true : nil
        taskReordering = supportsTaskReordering ? true : nil
        taskOrganization = supportsTaskOrganization ? true : nil
        taskPlans = supportsTaskPlans ? true : nil
        taskTypes = supportsTaskTypes ? true : nil
        self.historyByTask = historyByTask
        self.activityByTask = activityByTask
        commentActivity = supportsCommentActivity ? true : nil
        completionDates = includesCompletionDates ? true : nil
        taskUpdateDates = includesTaskUpdateDates ? true : nil
        revisionWithdrawal = supportsRevisionWithdrawal ? true : nil
    }

    public var canUseAgents: Bool { agentConnectionReady == true }

    /// The agents to offer: the full list from a current Mac, or the earlier fields from an older one.
    public var agents: PhoneAgentChoices {
        agentChoices ?? PhoneAgentChoices(defaultAgent: defaultAgent, availableAgents: availableAgents, agentModels: agentModels)
    }

    public var supportsNoteEditing: Bool { noteEditing == true }
    public var supportsFieldEditing: Bool { fieldEditing == true }
    public var includesCardMetadata: Bool { cardMetadata == true }
    public var supportsDispatchComments: Bool { dispatchComments == true }
    public var supportsTaskOverrides: Bool { taskOverrides == true }
    public var supportsBulkArchive: Bool { bulkArchive == true }
    public var supportsTaskReordering: Bool { taskReordering == true }
    public var supportsTaskOrganization: Bool { taskOrganization == true }
    public var supportsTaskPlans: Bool { taskPlans == true }
    public var supportsCommentActivity: Bool { commentActivity == true }
    public var supportsTaskTypes: Bool { taskTypes == true }
    /// Older Macs cannot read a withdrawal, so the phone only sends one when the Mac asks for them.
    public var supportsRevisionWithdrawal: Bool { revisionWithdrawal == true }

    var projectionVersion: Int {
        if agentChoices != nil || supportsRevisionWithdrawal { return 24 }
        if filesByTask != nil { return 23 }
        if taskUpdateDates == true { return 22 }
        if agentConnectionReady != nil { return 21 }
        if completionDates == true { return 20 }
        if supportsCommentActivity { return 19 }
        if activityByTask != nil { return 18 }
        if historyByTask != nil { return 17 }
        if supportsTaskTypes { return 16 }
        if supportsTaskPlans { return 15 }
        if supportsTaskOrganization { return 14 }
        if supportsTaskReordering { return 13 }
        if supportsBulkArchive { return 12 }
        if supportsTaskOverrides { return 11 }
        if macName != nil { return 10 }
        if captureProjectID != nil { return 9 }
        if trashedTasks != nil { return 8 }
        if supportsDispatchComments { return 7 }
        if agentModels != nil { return 6 }
        if availableAgents != nil { return 5 }
        if includesCardMetadata { return 4 }
        if supportsFieldEditing { return 3 }
        if supportsNoteEditing { return 2 }
        return commentsByTask == nil ? 0 : 1
    }

    func shouldReplace(_ stored: PhoneSnapshot) -> Bool {
        if revision != stored.revision { return revision > stored.revision }
        if projectionVersion != stored.projectionVersion { return projectionVersion > stored.projectionVersion }
        return agentConnectionReady != stored.agentConnectionReady || agents != stored.agents || captureProjectID != stored.captureProjectID || macName != stored.macName
    }
}

public enum PhoneTaskFieldEdit: Codable, Sendable {
    case project(String)
    case status(PhoneTask.Status, agent: PhoneAgent? = nil, model: String? = nil, dispatchComment: String? = nil)
    case priority(PhoneTask.Priority)
    case issueType(IssueType)
    case dueDate(String?)
    case title(String)
    case notes(String)
    case definitionOfDone(String)

    public enum Field: String, Sendable { case project, status, priority, dueDate, title, notes, definitionOfDone, issueType }

    public var field: Field {
        switch self {
        case .project: .project
        case .status: .status
        case .priority: .priority
        case .issueType: .issueType
        case .dueDate: .dueDate
        case .title: .title
        case .notes: .notes
        case .definitionOfDone: .definitionOfDone
        }
    }

    public var value: String? {
        switch self {
        case .project(let id): id
        case .status(let status, _, _, _): status.rawValue
        case .priority(let priority): priority.rawValue
        case .issueType(let type): type.rawValue
        case .dueDate(let date): date
        case .title(let text), .notes(let text), .definitionOfDone(let text): text
        }
    }

    public var label: String {
        switch self {
        case .project: "Change project"
        case .status(.sent, let agent, _, _): agent.map { "Send to \($0.title)" } ?? "Send to agent"
        case .status: "Change status"
        case .priority: "Change priority"
        case .issueType: "Change issue type"
        case .dueDate: "Change due date"
        case .title: "Change title"
        case .notes: "Edit notes"
        case .definitionOfDone: "Change definition of done"
        }
    }
}

public struct PhoneRequest: Codable, Identifiable, Sendable {
    public enum TaskDestination: String, Codable, Sendable { case archive, trash, active }

    public enum Action: Codable, Sendable {
        case loadActivity(taskID: String, beforeSequence: Int?)
        case loadCommentActivity(taskID: String, commentID: String, beforeSequence: Int?)
        case loadHistory(taskID: String, beforeVersion: Int?)
        case restoreRevision(taskID: String, historyID: String, revision: Int)
        case createProject(name: String)
        case savePlan(taskID: String, expectedMarkdown: String, markdown: String)
        case attachFile(taskID: String, file: TaskFilePayload)
        case organizeTask(taskID: String, destination: TaskDestination)
        case create(projectID: String, title: String, notes: String, priority: PhoneTask.Priority,
                    sendToAgent: Bool, definitionOfDone: String? = nil, agent: PhoneAgent? = nil, model: String? = nil,
                    dispatchComment: String? = nil, newProjectName: String? = nil, planMarkdown: String? = nil, issueType: IssueType? = nil)
        case send(taskID: String, revision: Int, agent: PhoneAgent? = nil)
        case complete(taskID: String, revision: Int)
        case comment(taskID: String, text: String)
        case withdrawComment(taskID: String, commentID: String)
        case editNotes(taskID: String, revision: Int, notes: String)
        case editField(taskID: String, revision: Int, edit: PhoneTaskFieldEdit)
        case setField(taskID: String, expected: String?, edit: PhoneTaskFieldEdit)
        case forceComplete(taskID: String)
        case removeArchived(taskID: String, revision: Int, permanently: Bool)
        case restoreTrashed(taskID: String, revision: Int)
        case emptyTrash(revision: Int)
        case manageArchive(taskIDs: [String], revision: Int, permanently: Bool)
        case reorderTask(taskID: String, projectID: String, status: PhoneTask.Status, anchorID: String, before: Bool)
    }

    public let id: UUID
    public let workspaceID: UUID
    public let createdAt: Date
    public let action: Action

    public init(workspaceID: UUID, action: Action) {
        id = UUID()
        self.workspaceID = workspaceID
        createdAt = .now
        self.action = action
    }

    public var taskID: String? {
        switch action {
        case .create, .createProject, .emptyTrash, .manageArchive: nil
        case .send(let id, _, _), .complete(let id, _), .comment(let id, _), .withdrawComment(let id, _),
             .editNotes(let id, _, _), .editField(let id, _, _), .setField(let id, _, _), .forceComplete(let id),
             .removeArchived(let id, _, _), .restoreTrashed(let id, _), .reorderTask(let id, _, _, _, _),
             .organizeTask(let id, _), .savePlan(let id, _, _), .attachFile(let id, _), .loadHistory(let id, _), .restoreRevision(let id, _, _), .loadActivity(let id, _), .loadCommentActivity(let id, _, _): id
        }
    }

    public var changesTask: Bool {
        switch action {
        case .send, .complete, .editNotes, .editField, .setField, .forceComplete, .removeArchived, .restoreTrashed,
             .organizeTask, .savePlan, .restoreRevision: true
        case .create, .createProject, .comment, .withdrawComment, .attachFile, .emptyTrash, .manageArchive, .reorderTask, .loadHistory, .loadActivity, .loadCommentActivity: false
        }
    }

    /// The ID a revision request keeps on every device, from the moment it is queued.
    public var revisionID: String? {
        if case .comment = action { return id.uuidString.lowercased() }
        return nil
    }

    public var withdrawnRevisionID: String? {
        if case .withdrawComment(_, let commentID) = action { return commentID }
        return nil
    }

    /// Withdrawals go first, so a request withdrawn in the same batch is never saved or sent to an agent.
    public static func applicationOrder(_ requests: [PhoneRequest]) -> [PhoneRequest] {
        requests.filter { $0.withdrawnRevisionID != nil } + requests.filter { $0.withdrawnRevisionID == nil }
    }

    var assetLimit: Int {
        if case .attachFile = action { return 16 * 1024 * 1024 }
        return 1024 * 1024
    }
}

public struct PhoneReceipt: Codable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable { case applied, waiting, rejected }
    public let requestID: UUID
    public let outcome: Outcome
    public let revision: Int?
    public let message: String?
    public let createdTaskID: String?
    public let history: TaskHistoryPage?
    public let activity: TaskActivityPage?

    public init(requestID: UUID, outcome: Outcome, revision: Int? = nil, message: String? = nil,
                createdTaskID: String? = nil, history: TaskHistoryPage? = nil, activity: TaskActivityPage? = nil) {
        self.requestID = requestID
        self.outcome = outcome
        self.revision = revision
        self.message = message
        self.createdTaskID = createdTaskID
        self.history = history
        self.activity = activity
    }

    public func isSettled(at snapshotRevision: Int) -> Bool {
        switch outcome {
        case .waiting: false
        case .rejected: true
        case .applied: revision.map { snapshotRevision >= $0 } ?? false
        }
    }
}

public enum CompanionSyncError: LocalizedError {
    case missingWorkspace, unsupportedVersion, oversizedRecord

    public var errorDescription: String? {
        switch self {
        case .missingWorkspace: "Open OpenTalon on your Mac to sync your tasks."
        case .unsupportedVersion: "Update OpenTalon on both devices to sync your tasks."
        case .oversizedRecord: "The OpenTalon workspace is too large to sync."
        }
    }
}
