import CryptoKit
import Foundation
import UniformTypeIdentifiers

public struct TaskFile: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let taskId: String
    public let name: String
    public let contentType: String
    public let byteCount: Int
    public let sha256: String
    public let createdAt: String

    public var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(byteCount), countStyle: .file)
    }

    func recordName(in workspaceID: UUID) throws -> String {
        guard let fileID = UUID(uuidString: id), sha256.count == 64,
              sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw TaskFileError.invalidData
        }
        return "file-\(workspaceID.uuidString)-\(fileID.uuidString)-\(sha256)"
    }

    public func verify(_ data: Data) throws {
        guard byteCount == data.count, data.count <= TaskFilePayload.maxBytes,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else {
            throw TaskFileError.invalidData
        }
    }

    public func cachedURL(in directory: URL) throws -> URL {
        guard let fileID = UUID(uuidString: id) else { throw TaskFileError.invalidData }
        try TaskFilePayload.validateName(name)
        return directory.appending(path: fileID.uuidString, directoryHint: .isDirectory).appending(path: name)
    }

    public func preview(_ data: Data, in directory: URL) throws -> URL {
        try verify(data)
        let url = try cachedURL(in: directory)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        return url
    }
}

public struct TaskFilePayload: Codable, Sendable {
    public static let maxBytes = 10 * 1024 * 1024
    private static let videoExtensions = Set("3g2 3gp 3gpp asf avi dv f4v flv m2ts m4v mkv mov mp4 mpe mpeg mpg mts mxf ogv rm rmvb vob webm wmv".split(separator: " ").map(String.init))
    public let name: String
    public let contentType: String
    public let bytes: Data

    static func validateName(_ name: String) throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name != ".", name != "..",
              name.utf8.count <= 240, name.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\:").union(.controlCharacters)) == nil
        else { throw TaskFileError.invalidName }
    }

    public static func importFile(_ url: URL) async throws -> TaskFilePayload {
        try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            try validateName(name)
            let fileExtension = url.pathExtension.lowercased()
            if videoExtensions.contains(fileExtension) { throw TaskFileError.video }

            var error: NSError?
            var result: Result<TaskFilePayload, Error>?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { resolved in
                result = Result {
                    let values = try resolved.resourceValues(forKeys: [.contentTypeKey, .isRegularFileKey])
                    let type = values.contentType ?? UTType(filenameExtension: fileExtension)
                    guard values.isRegularFile == true else { throw TaskFileError.regularFile }
                    if fileExtension != "ts", type?.conforms(to: .movie) == true || type?.conforms(to: .video) == true {
                        throw TaskFileError.video
                    }
                    let mime = fileExtension == "ts" && type?.preferredMIMEType == "video/mp2t"
                        ? "application/octet-stream" : type?.preferredMIMEType ?? "application/octet-stream"
                    return TaskFilePayload(name: name, contentType: mime, bytes: try readBytes(resolved))
                }
            }
            if let error { throw error }
            guard let result else { throw TaskFileError.unavailable }
            return try result.get()
        }.value
    }

    static func readBytes(_ url: URL) throws -> Data {
        let reader = try FileHandle(forReadingFrom: url)
        defer { try? reader.close() }
        let bytes = try reader.read(upToCount: maxBytes + 1) ?? Data()
        guard bytes.count <= maxBytes else { throw TaskFileError.tooLarge }
        return bytes
    }
}

public enum TaskFileError: LocalizedError {
    case invalidData, invalidName, regularFile, tooLarge, unavailable, video, updateMac, queueFull

    public var errorDescription: String? {
        switch self {
        case .invalidData: "OpenTalon couldn’t verify this file."
        case .invalidName: "Choose a file with a valid filename of up to 240 bytes."
        case .regularFile: "Choose a file."
        case .tooLarge: "Files can be up to 10 MB each."
        case .unavailable: "This file hasn’t downloaded yet. Try again after OpenTalon syncs."
        case .video: "Video files cannot be attached."
        case .updateMac: "Update OpenTalon on your Mac to attach files."
        case .queueFull: "Sync your queued files before attaching another file."
        }
    }
}
