import ActivityKit
import WidgetKit
import SwiftUI

struct TimerClock: View {
    let state: JockiTimerAttributes.ContentState
    var body: some View {
        Group {
            if state.paused {
                Text(Duration.seconds(state.end.map { max(0, $0.timeIntervalSince(state.start) - state.elapsed) } ?? state.elapsed).formatted(.time(pattern: .hourMinuteSecond)))
            } else if let end = state.end {
                if end > .now { Text(timerInterval: Date.now...end, countsDown: true) } else { Text("Finished") }
            } else { Text(state.start, style: .timer) }
        }.monospacedDigit()
    }
}
@main struct JockiTimerWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: JockiTimerAttributes.self) { context in
            HStack { Image(systemName: "timer"); VStack(alignment: .leading) { Text(context.state.title).font(.headline); TimerClock(state: context.state).font(.title) } }.padding().activityBackgroundTint(.black).activitySystemActionForegroundColor(.white).foregroundStyle(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "timer") }
                DynamicIslandExpandedRegion(.trailing) { TimerClock(state: context.state) }
                DynamicIslandExpandedRegion(.bottom) { Text(context.state.title) }
            } compactLeading: { Image(systemName: "timer") } compactTrailing: { TimerClock(state: context.state).frame(maxWidth: 70) } minimal: { Image(systemName: "timer") }
        }
    }
}
