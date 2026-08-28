import EventKit
import Foundation

/**
 * События календаря вокруг текущего момента.
 *
 * Нужны, чтобы запись сразу получала настоящее название и список участников:
 * иначе в архиве остаются «Запись 27 августа, 21:16» и «Участник 2», по
 * которым потом ничего не найти.
 */
struct CalendarEvent: Encodable {
    let id: String
    let title: String
    let startsAt: String
    let endsAt: String
    let participants: [String]
    let location: String?
    let notes: String?
    /// Идёт прямо сейчас, а не «скоро начнётся».
    let isNow: Bool
}

private let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

/**
 * Запрос разрешения у системы.
 *
 * Ждём, прокручивая цикл событий, а не блокируя поток семафором: окно запроса
 * показывает система, и ей нужен живой главный поток. С заблокированным
 * потоком окно не появлялось вовсе, а ответ приходил мгновенным отказом.
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

    // Человеку нужно время прочитать запрос и нажать кнопку.
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
 * Отказано ли окончательно.
 *
 * Отличать это от «ещё не спрашивали» обязательно: системный диалог macOS
 * показывает один раз, и после отказа повторный запрос молча возвращает
 * false. Приложение должно в этом случае вести человека в настройки, а не
 * предлагать нажать кнопку, которая уже ничего не делает.
 */
func calendarDenied() -> Bool {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        return status == .denied || status == .restricted || status == .writeOnly
    }
    return status == .denied || status == .restricted
}

/**
 * События в окне вокруг «сейчас».
 *
 * Смотрим и назад, и вперёд: запись часто начинают через пару минут после
 * начала встречи или за минуту до неё.
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
            // Организатора включаем тоже: он такой же участник разговора.
            var names: [String] = []
            if let organizer = event.organizer?.name, !organizer.isEmpty { names.append(organizer) }
            for attendee in event.attendees ?? [] {
                guard let name = attendee.name, !name.isEmpty, !names.contains(name) else { continue }
                names.append(name)
            }
            return CalendarEvent(
                id: event.eventIdentifier ?? UUID().uuidString,
                title: event.title ?? "Без названия",
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
