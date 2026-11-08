/** What the Stats page's listening year reads out of the log's timestamps.
 * All of it is in the listener's own time zone, which is why it happens here
 * and not in connect. */

export interface YearDay {
  date: Date
  count: number
  /** 0 for nothing played, 1-4 for how much compared with this listener's
   * own busy days. */
  level: number
}

export interface YearWeek {
  /** Monday first. Null for a day that has not happened yet. */
  days: (YearDay | null)[]
  /** The month this week opens, 0-11, or null when it continues one. */
  month: number | null
}

const DAY_MS = 86_400_000

/** A calendar day as a plain integer, which keeps a daylight saving change
 * (a 23- or 25-hour day) out of the arithmetic. */
function dayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

function dateFor(day: number): Date {
  const utc = new Date(day * DAY_MS)
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
}

function countsByDay(timestamps: number[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const ts of timestamps) {
    const day = dayNumber(new Date(ts * 1000))
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  return counts
}

/** The 95th percentile rather than the maximum: one party night would
 * otherwise leave every ordinary day in the lowest step. */
function busyDay(counts: number[]): number {
  const sorted = [...counts].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 1
}

function levelOf(count: number, busy: number): number {
  if (count === 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / busy) * 4)))
}

/** `weeks` columns ending with the week `today` is in. */
export function buildYear(timestamps: number[], today: Date, weeks = 53): YearWeek[] {
  const counts = countsByDay(timestamps)
  const lastDay = dayNumber(today)
  const mondayOffset = (today.getDay() + 6) % 7
  const firstMonday = lastDay - mondayOffset - (weeks - 1) * 7

  const shown: number[] = []
  for (let day = firstMonday; day <= lastDay; day++) {
    const count = counts.get(day)
    if (count) shown.push(count)
  }
  const busy = busyDay(shown)

  const result: YearWeek[] = []
  let lastMonth = -1
  for (let week = 0; week < weeks; week++) {
    const monday = firstMonday + week * 7
    const days: (YearDay | null)[] = []
    for (let offset = 0; offset < 7; offset++) {
      const day = monday + offset
      if (day > lastDay) {
        days.push(null)
        continue
      }
      const count = counts.get(day) ?? 0
      days.push({ date: dateFor(day), count, level: levelOf(count, busy) })
    }
    const month = dateFor(monday).getMonth()
    result.push({ days, month: month === lastMonth ? null : month })
    lastMonth = month
  }
  return result
}

/** A streak survives today not having been played yet: it only ends once a
 * whole day has gone by without music. */
export function streaks(
  timestamps: number[],
  today: Date,
): {
  current: number
  longest: number
} {
  const played = new Set(countsByDay(timestamps).keys())

  let longest = 0
  for (const day of played) {
    if (played.has(day - 1)) continue
    let length = 1
    while (played.has(day + length)) length += 1
    longest = Math.max(longest, length)
  }

  const todayNumber = dayNumber(today)
  let cursor = played.has(todayNumber) ? todayNumber : todayNumber - 1
  let current = 0
  while (played.has(cursor)) {
    current += 1
    cursor -= 1
  }
  return { current, longest }
}

/** Plays per hour of the day, midnight first. */
export function playsByHour(timestamps: number[]): number[] {
  const hours = Array.from({ length: 24 }, () => 0)
  for (const ts of timestamps) {
    const hour = new Date(ts * 1000).getHours()
    hours[hour] = (hours[hour] ?? 0) + 1
  }
  return hours
}
