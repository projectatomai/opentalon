import Foundation

/// Frames newline-delimited service responses without rescanning earlier chunks.
public struct ServiceLineBuffer {
    private var buffer = Data()
    private var scannedCount = 0
    private static let newline = Data([0x0a])

    public init() {}

    public mutating func append(_ bytes: Data) -> [Data] {
        buffer.append(bytes)
        var start = buffer.startIndex
        var search = start + scannedCount
        var lines: [Data] = []
        while search < buffer.endIndex,
              let end = buffer.range(of: Self.newline, in: search..<buffer.endIndex) {
            lines.append(Data(buffer[start..<end.lowerBound]))
            start = end.upperBound
            search = start
        }
        if start > buffer.startIndex { buffer.removeSubrange(buffer.startIndex..<start) }
        scannedCount = buffer.count
        return lines
    }
}
