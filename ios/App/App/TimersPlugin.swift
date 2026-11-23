import Capacitor
import ActivityKit
import AlarmKit
import AppIntents
import SwiftUI
import UserNotifications
import CryptoKit

private func timerAlarmID(_ key: String) -> UUID {
    var bytes = Array(SHA256.hash(data: Data(key.utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x50
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
}

@available(iOS 26.0, *)
struct TimerAlarmMetadata: AlarmMetadata { var key: String }
@available(iOS 26.0, *)
struct StopJockiAlarm: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop Jocki timer"
    @Parameter(title: "Timer") var key: String
    init() {}
    init(key: String) { self.key = key }
    func perform() async throws -> some IntentResult {
        let defaults = UserDefaults.standard
        var dismissed = defaults.stringArray(forKey: "timerDismissed") ?? []
        if !dismissed.contains(key) { dismissed.append(key) }
        defaults.set(dismissed, forKey: "timerDismissed")
        try? AlarmManager.shared.stop(id: timerAlarmID(key))
        return .result()
    }
}
@objc(TimersPlugin)
public class TimersPlugin: CAPPlugin, CAPBridgedPlugin, UNUserNotificationCenterDelegate {
    public override func load() { UNUserNotificationCenter.current().delegate = self }
    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound]) }
    public let identifier = "TimersPlugin"
    public let jsName = "Timers"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "dismissed", returnType: CAPPluginReturnPromise)]
    @objc func requestPermission(_ call: CAPPluginCall) {
        Task { @MainActor in
            let notifications = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
            var alarms = false
            if #available(iOS 26.0, *), call.getBool("alarms") == true { alarms = (try? await AlarmManager.shared.requestAuthorization()) == .authorized }
            call.resolve(["granted": notifications || alarms, "persistent": alarms])
        }
    }
    @objc func dismissed(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard, keys = defaults.stringArray(forKey: "timerDismissed") ?? []
        defaults.removeObject(forKey: "timerDismissed")
        call.resolve(["dismissed": keys.compactMap { key -> [String:String]? in let parts = key.split(separator: ":", maxSplits: 1).map(String.init); return parts.count == 2 ? ["pluginId": parts[0], "id": parts[1]] : nil }])
    }
    @objc func present(_ call: CAPPluginCall) {
        guard let timers = call.getArray("timers", JSObject.self), timers.count <= 32 else { call.reject("Invalid timers"); return }
        Task { @MainActor in
            do { try await update(timers); call.resolve([:]) } catch { call.reject("Unable to present system timers", nil, error) }
        }
    }
    @MainActor private func update(_ timers: [JSObject]) async throws {
        let defaults = UserDefaults.standard
        var ids = (defaults.dictionary(forKey: "timerAlarmIDs") as? [String:String]) ?? [:]
        var signatures = (defaults.dictionary(forKey: "timerAlarmSignatures") as? [String:String]) ?? [:]
        let ordered = timers.sorted { ($0["priority"] as? Double ?? 0) > ($1["priority"] as? Double ?? 0) }
        let keys = Set(ordered.compactMap { timer -> String? in guard let plugin = timer["pluginId"] as? String, let id = timer["id"] as? String else { return nil }; return plugin + ":" + id })
        for (key, value) in ids where !keys.contains(key) {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [value])
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [value])
            if #available(iOS 26.0, *), let id = UUID(uuidString: value) { try? AlarmManager.shared.cancel(id: id) }
            ids.removeValue(forKey: key); signatures.removeValue(forKey: key)
        }
        for activity in Activity<JockiTimerAttributes>.activities where !keys.contains(activity.attributes.key) { await activity.end(nil, dismissalPolicy: .immediate) }
        for (rank, timer) in ordered.enumerated() {
            guard let plugin = timer["pluginId"] as? String, let id = timer["id"] as? String, let startMs = timer["startedAt"] as? Double, startMs.isFinite, let title = timer["title"] as? String else { continue }
            let key = plugin + ":" + id, paused = timer["pausedAt"] as? Double, pausedMs = timer["pausedMs"] as? Double ?? 0
            let start = Date(timeIntervalSince1970: (startMs + pausedMs) / 1000)
            let duration = timer["durationMs"] as? Double, end = duration.map { start.addingTimeInterval($0 / 1000) }
            let elapsed = max(0, ((paused ?? Date.now.timeIntervalSince1970 * 1000) - startMs - pausedMs) / 1000)
            let state = JockiTimerAttributes.ContentState(title: String(title.prefix(200)), start: start, end: end, paused: paused != nil, elapsed: elapsed)
            let content = ActivityContent(state: state, staleDate: end, relevanceScore: 1 - Double(rank) / Double(ordered.count + 1))
            if timer["completedAt"] == nil {
                if let activity = Activity<JockiTimerAttributes>.activities.first(where: { $0.attributes.key == key }) { await activity.update(content) }
                else if ActivityAuthorizationInfo().areActivitiesEnabled {
                    do { _ = try Activity.request(attributes: JockiTimerAttributes(key: key), content: content, pushType: nil) }
                    catch { // If the OS permits only one slot, the highest-priority timer replaces a lower-priority one.
                        if key == ordered.first.map({ ($0["pluginId"] as? String ?? "") + ":" + ($0["id"] as? String ?? "") }), let lower = Activity<JockiTimerAttributes>.activities.last { await lower.end(nil, dismissalPolicy: .immediate); _ = try? Activity.request(attributes: JockiTimerAttributes(key: key), content: content, pushType: nil) }
                    }
                }
            } else if let activity = Activity<JockiTimerAttributes>.activities.first(where: { $0.attributes.key == key }) { await activity.end(content, dismissalPolicy: .immediate) }
            let value = timerAlarmID(key).uuidString; ids[key] = value
            let alert = timer["alert"] as? [String:Any] ?? [:], tone = alert["tone"] as? String ?? "none", repeated = alert["repeat"] as? String == "indefinite"
            let signature = "\(end?.timeIntervalSince1970 ?? 0):\(paused != nil):\(tone):\(repeated)"
            if signatures[key] == signature { continue }
            signatures[key] = signature
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [value])
            if #available(iOS 26.0, *), let uuid = UUID(uuidString: value) { try? AlarmManager.shared.cancel(id: uuid) }
            guard let end, end > .now, paused == nil, ["none", "chime", "bell", "gentle"].contains(tone) else { continue }
            if #available(iOS 26.0, *), repeated, tone != "none", AlarmManager.shared.authorizationState == .authorized {
                let presentation = AlarmPresentation(alert: .init(title: LocalizedStringResource(stringLiteral: String(title.prefix(200))), stopButton: .init(text: "Stop", textColor: .white, systemImageName: "stop.circle")))
                let attributes = AlarmAttributes(presentation: presentation, metadata: TimerAlarmMetadata(key: key), tintColor: .orange)
                _ = try await AlarmManager.shared.schedule(id: UUID(uuidString: value)!, configuration: .alarm(schedule: .fixed(end), attributes: attributes, stopIntent: StopJockiAlarm(key: key), sound: .named(tone + ".wav")))
            } else {
                let content = UNMutableNotificationContent(); content.title = "Timer finished"; content.body = String(title.prefix(200)); content.sound = tone == "none" ? nil : UNNotificationSound(named: .init(tone + ".wav"))
                try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: value, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, end.timeIntervalSinceNow), repeats: false)))
            }
        }
        defaults.set(ids, forKey: "timerAlarmIDs"); defaults.set(signatures, forKey: "timerAlarmSignatures")
    }
}
