import ActivityKit
import Foundation

struct JockiTimerAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var start: Date
        var end: Date?
        var paused: Bool
        var elapsed: Double
    }
    var key: String
}
