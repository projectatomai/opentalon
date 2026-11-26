/// Limits row construction while keeping the complete collection available for counts and ordering.
public struct TaskPageWindow: Equatable, Sendable {
    public static let batchSize = 6
    public private(set) var limit = batchSize

    public init() {}

    public mutating func revealNext(total: Int) {
        guard total > limit else { return }
        limit = min(total, limit + Self.batchSize)
    }

    public mutating func revealThrough(index: Int, total: Int) {
        guard index >= limit, index < total else { return }
        limit = min(total, (index / Self.batchSize + 1) * Self.batchSize)
    }

    public mutating func reset() { limit = Self.batchSize }
}
