import Foundation

/// Decides how a phone withdraws one of the user's revision requests.
public enum RevisionWithdrawal {
    public enum Plan: Equatable, Sendable {
        /// The request never left this device, so removing it here is the whole withdrawal.
        case discard(requestID: UUID)
        /// The request may have reached iCloud or the Mac. The Mac withdraws it by its stable ID.
        case request(commentID: String)
    }

    public enum Failure: LocalizedError, Equatable {
        case updateMac, alreadyActedOn, missing

        public var errorDescription: String? {
            switch self {
            case .updateMac: "Update OpenTalon on your Mac to withdraw revision requests it has already received."
            case .alreadyActedOn: "The agent already acted on this revision request."
            case .missing: "This revision request is no longer on this task."
            }
        }
    }

    /// - Parameter unsent: Requests queued on this device that have never been offered to iCloud.
    public static func plan(revisionID: String, taskID: String, pending: [PhoneRequest], unsent: Set<UUID>,
                            snapshot: PhoneSnapshot) throws -> Plan {
        let queued = pending.first { request in
            guard request.workspaceID == snapshot.workspaceID, request.revisionID == revisionID,
                  case .comment(let id, _) = request.action else { return false }
            return id == taskID
        }
        if let queued, unsent.contains(queued.id) { return .discard(requestID: queued.id) }
        guard snapshot.supportsRevisionWithdrawal else { throw Failure.updateMac }
        if queued != nil { return .request(commentID: revisionID) }
        // A request is only ever withdrawn from the task that holds it.
        guard let saved = snapshot.commentsByTask?[taskID]?.first(where: { $0.id == revisionID }) else {
            throw Failure.missing
        }
        guard saved.canWithdraw else { throw Failure.alreadyActedOn }
        return .request(commentID: revisionID)
    }

    /// Drops IDs whose withdrawal and original request have both left the queue.
    public static func stillWithdrawing(_ ids: Set<String>, pending: [PhoneRequest]) -> Set<String> {
        ids.filter { id in pending.contains { $0.withdrawnRevisionID == id || $0.revisionID == id } }
    }

    /// A request the user withdrew is expected to be turned away by the Mac, so that is not reported as a failure.
    public static func hidesRejection(of request: PhoneRequest, withdrawing: Set<String>) -> Bool {
        request.revisionID.map(withdrawing.contains) ?? false
    }

    /// Whether the delete control should be offered at all for a saved request.
    public static func isOffered(for comment: PhoneComment, in snapshot: PhoneSnapshot) -> Bool {
        snapshot.supportsRevisionWithdrawal && comment.canWithdraw
    }
}
