import Foundation
import Testing
@testable import CompanionCore

@Test func serviceLinesHandlePartialPacketsAndLargeWorkspaceResponses() {
    var buffer = ServiceLineBuffer()
    #expect(buffer.append(Data("first\nsec".utf8)) == [Data("first".utf8)])
    #expect(buffer.append(Data()).isEmpty)
    #expect(buffer.append(Data("ond\n\nthird\nlast".utf8)) ==
            [Data("second".utf8), Data(), Data("third".utf8)])
    #expect(buffer.append(Data("\n".utf8)) == [Data("last".utf8)])
    let chunk = Data(repeating: 0x61, count: 16_384)
    for _ in 0..<2_048 { #expect(buffer.append(chunk).isEmpty) }
    let lines = buffer.append(Data([0x0a]))
    #expect(lines.count == 1)
    #expect(lines.first?.count == 32 * 1_024 * 1_024)
    #expect(lines.first?.allSatisfy { $0 == 0x61 } == true)
    #expect(buffer.append(Data("next\n".utf8)) == [Data("next".utf8)])
}

@Test func taskWindowsStartAtSixAndReachEveryItemWithoutTruncation() {
    for total in [0, 1, 6, 7, 101, 1_001] {
        let tasks = Array(0..<total)
        var page = TaskPageWindow()
        #expect(page.limit == 6)
        #expect(Array(tasks.prefix(page.limit)) == Array(tasks.prefix(6)))
        while page.limit < total {
            let previous = page.limit
            page.revealNext(total: total)
            #expect(page.limit > previous && page.limit - previous <= 6)
        }
        #expect(Array(tasks.prefix(page.limit)) == tasks)
        let final = page.limit
        page.revealNext(total: total)
        #expect(page.limit == final)
        page.reset()
        #expect(page.limit == 6)
    }
}

@Test func dragScrollingRevealsItsTargetWithoutLoadingTheEntireColumn() {
    var page = TaskPageWindow()
    page.revealThrough(index: 6, total: 101)
    #expect(page.limit == 12)
    page.revealThrough(index: 18, total: 101)
    #expect(page.limit == 24)
    page.revealThrough(index: 100, total: 101)
    #expect(page.limit == 101)
    page.reset()
    page.revealThrough(index: -1, total: 101)
    page.revealThrough(index: 101, total: 101)
    #expect(page.limit == 6)
}

@Test func fastTaskDatesPreserveStoredTimestampSemantics() {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let whole = ISO8601DateFormatter()
    whole.formatOptions = [.withInternetDateTime]
    for stamp in ["2026-11-21T12:34:56.123Z", "2026-11-21T12:34:56Z",
                  "2026-11-21T07:34:56.123-05:00", "2026-11-21T07:34:56-05:00", "invalid", ""] {
        let parsed = TaskCreationOrder.date(from: stamp)
        let previous = fractional.date(from: stamp) ?? whole.date(from: stamp)
        if let parsed, let previous { #expect(abs(parsed.timeIntervalSince(previous)) < 0.000_001) }
        else { #expect(parsed == previous) }
    }
    let dates = (0..<101).map { Date(timeIntervalSince1970: 1_795_000_000 + Double($0 * 37)) }
    #expect(dates.map { TaskCreationOrder.date(from: fractional.string(from: $0)) } == dates.map(Optional.some))
    let oldDay = DateFormatter()
    oldDay.locale = Locale(identifier: "en_US_POSIX")
    oldDay.calendar = Calendar(identifier: .gregorian)
    oldDay.dateFormat = "yyyy-MM-dd"
    for date in dates + [Date(timeIntervalSince1970: 0), Date(timeIntervalSince1970: -1)] {
        #expect(CalendarDay.key(date) == oldDay.string(from: date))
    }
}
