import EventKit
import Foundation

/**
 * Calendar events around the current moment.
 *
 * They are there so that a recording gets a real title and a participant list
 * straight away: otherwise the archive is left with "Recording, 27 August,
 * 21:16" and "Speaker 2", by which nothing can be found later.
 */
struct CalendarEvent: Encodable {
    let id: String
    let title: String
    let startsAt: String
    let endsAt: String
    let participants: [String]
    let location: String?
    let notes: String?
    /// Happening right now, rather than "starting soon".
    let isNow: Bool
}

private let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

/**
 * Asking the system for permission.
 *
 * We wait by turning the run loop rather than blocking the thread with a
 * semaphore: the request window is shown by the system, and it needs a live
 * main thread. With the thread blocked the window never appeared at all, and
 * the answer came back as an instant refusal.
 */
func requestCalendarAccess(store: EKEventStore) -> Bool {
    var granted = false
    var finished = false

    let complete: (Bool, Error?) -> Void = { ok, _ in
        granted = ok
        finished = true
    }

    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents(completion: complete)
    } else {
        store.requestAccess(to: .event, completion: complete)
    }

    // A person needs time to read the request and press a button.
    let deadline = Date().addingTimeInterval(120)
    while !finished && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    return granted
}

func calendarAuthorized() -> Bool {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        return status == .fullAccess
    }
    return status == .authorized
}

/**
 * Whether it has been refused for good.
 *
 * Telling this apart from "not asked yet" is essential: macOS shows its dialog
 * once, and after a refusal a repeat request silently returns false. In that
 * case the application has to lead the person to settings rather than offer a
 * button that no longer does anything.
 */
func calendarDenied() -> Bool {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        return status == .denied || status == .restricted || status == .writeOnly
    }
    return status == .denied || status == .restricted
}

/**
 * The events in a window around "now".
 *
 * We look both back and forward: a recording is often started a couple of
 * minutes after a meeting began, or a minute before it.
 */
func calendarEvents(backMinutes: Int, forwardMinutes: Int) -> [CalendarEvent] {
    let store = EKEventStore()
    guard calendarAuthorized() else { return [] }

    let now = Date()
    let from = now.addingTimeInterval(-Double(backMinutes) * 60)
    let to = now.addingTimeInterval(Double(forwardMinutes) * 60)
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)

    return store.events(matching: predicate)
        .filter { !$0.isAllDay }
        .map { event in
            // The organiser is included too: they are as much a participant as anyone.
            var names: [String] = []
            if let organizer = event.organizer?.name, !organizer.isEmpty { names.append(organizer) }
            for attendee in event.attendees ?? [] {
                guard let name = attendee.name, !name.isEmpty, !names.contains(name) else { continue }
                names.append(name)
            }
            return CalendarEvent(
                id: event.eventIdentifier ?? UUID().uuidString,
                title: event.title ?? "",
                startsAt: iso.string(from: event.startDate),
                endsAt: iso.string(from: event.endDate),
                participants: names,
                location: event.location,
                notes: event.notes,
                isNow: event.startDate <= now && event.endDate >= now
            )
        }
        .sorted { a, b in
            if a.isNow != b.isNow { return a.isNow }
            return a.startsAt < b.startsAt
        }
}
