import type { Song } from '@/types/library'

/** The sentence under the Stats page's headline: one a day out of everything
 * this listener's own numbers can say. Nothing here comes from outside, and a
 * line only joins in once its figure is big enough to be worth saying. */

export interface StatsLine {
  /** Below `stats.heroLines` in the locale files. */
  key: string
  params: Record<string, string>
}

export interface StatsLineInput {
  songs: Song[]
  /** The play log, oldest first, in seconds. */
  timestamps: number[]
  today: Date
  locale: string
}

const DAY_MS = 86_400_000
const LATE_FROM_HOUR = 22
const LATE_UNTIL_HOUR = 5
const EARLY_UNTIL_HOUR = 8
const MIN_SHARE = 10
const MIN_LOG_FOR_HABITS = 50
const MIN_LOG_DAYS_FOR_SPAN = 60
const LAST_YEAR_DAYS = 365
const LONGEST_GAP_WORTH_SAYING = 14
const MONTH_DAYS = 30
const OLDEST_CREDIBLE_YEAR = 1900

/** A calendar day as a whole number, so distances are plain subtraction and a
 * clock change cannot make one day two. */
function dayIndex(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

function sumBy<T>(items: T[], key: (item: T) => string | null, value: (item: T) => number) {
  const totals = new Map<string, number>()
  for (const item of items) {
    const name = key(item)
    if (name) totals.set(name, (totals.get(name) ?? 0) + value(item))
  }
  return totals
}

function largest<K>(totals: Map<K, number>): [K, number] | null {
  let best: [K, number] | null = null
  for (const entry of totals) if (!best || entry[1] > best[1]) best = entry
  return best
}

function playsPerDay(dates: Date[]): Map<number, number> {
  const days = new Map<number, number>()
  for (const date of dates) days.set(dayIndex(date), (days.get(dayIndex(date)) ?? 0) + 1)
  return days
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

interface Context {
  today: number
  thisMonth: string
  dates: Date[]
  days: Map<number, number>
  songs: Song[]
  played: Song[]
  totalPlays: number
  n: (value: number) => string
  dayName: (index: number) => string
  locale: string
}

type Builder = (c: Context) => StatsLine | null

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`
}

function playsWithin(c: Context, from: number, to: number): number {
  let total = 0
  for (const [day, plays] of c.days) if (day > from && day <= to) total += plays
  return total
}

function logSpan(c: Context): number {
  const first = c.dates[0]
  return first ? c.today - dayIndex(first) : 0
}

function shareOfHours(c: Context, inRange: (hour: number) => boolean): number {
  return Math.round((c.dates.filter((d) => inRange(d.getHours())).length / c.dates.length) * 100)
}

function shareLine(key: string, inRange: (hour: number) => boolean): Builder {
  return (c) => {
    if (c.dates.length < MIN_LOG_FOR_HABITS) return null
    const share = shareOfHours(c, inRange)
    return share >= MIN_SHARE ? { key, params: { n: String(share) } } : null
  }
}

const today: Builder = (c) => {
  const plays = c.days.get(c.today) ?? 0
  return plays >= 5 ? { key: 'today', params: { n: c.n(plays) } } : null
}

const lastWeek: Builder = (c) => {
  const plays = playsWithin(c, c.today - 7, c.today)
  return plays >= 10 ? { key: 'lastWeek', params: { n: c.n(plays) } } : null
}

const thisMonth: Builder = (c) => {
  const plays = c.dates.filter((date) => monthKey(date) === c.thisMonth).length
  return plays >= 20 ? { key: 'thisMonth', params: { n: c.n(plays) } } : null
}

const bestDay: Builder = (c) => {
  const best = largest(c.days)
  if (!best || best[1] < 10) return null
  return { key: 'bestDay', params: { n: c.n(best[1]), date: c.dayName(best[0]) } }
}

const bestMonth: Builder = (c) => {
  const months = sumBy(c.dates, monthKey, () => 1)
  const best = largest(months)
  if (!best || months.size < 3 || best[1] < 20) return null
  const [year = 0, month = 0] = best[0].split('-').map(Number)
  const name = new Date(year, month).toLocaleDateString(c.locale, { month: 'long' })
  return { key: 'bestMonth', params: { n: c.n(best[1]), month: name } }
}

const weekday: Builder = (c) => {
  if (c.dates.length < MIN_LOG_FOR_HABITS) return null
  const counts = new Map<number, number>()
  for (const date of c.dates) counts.set(date.getDay(), (counts.get(date.getDay()) ?? 0) + 1)
  const best = largest(counts)
  const sample = best && c.dates.find((date) => date.getDay() === best[0])
  if (!sample) return null
  return {
    key: 'weekday',
    params: { weekday: sample.toLocaleDateString(c.locale, { weekday: 'long' }) },
  }
}

const late = shareLine('late', (hour) => hour >= LATE_FROM_HOUR || hour < LATE_UNTIL_HOUR)
const early = shareLine('early', (hour) => hour >= LATE_UNTIL_HOUR && hour < EARLY_UNTIL_HOUR)

const daysActive: Builder = (c) => {
  if (logSpan(c) < MIN_LOG_DAYS_FOR_SPAN) return null
  const active = [...c.days.keys()].filter((day) => day > c.today - LAST_YEAR_DAYS).length
  return active >= 30 ? { key: 'daysActive', params: { n: c.n(active) } } : null
}

const typicalDay: Builder = (c) => {
  if (c.days.size < 14) return null
  const plays = median([...c.days.values()])
  return plays >= 3 ? { key: 'typicalDay', params: { n: c.n(plays) } } : null
}

const longestGap: Builder = (c) => {
  if (logSpan(c) < MIN_LOG_DAYS_FOR_SPAN) return null
  const active = [...c.days.keys()].sort((a, b) => a - b)
  let gap = 0
  let previous: number | null = null
  for (const day of active) {
    if (previous !== null) gap = Math.max(gap, day - previous - 1)
    previous = day
  }
  // A long one is not a boast.
  if (gap < 2 || gap > LONGEST_GAP_WORTH_SAYING) return null
  return { key: 'longestGap', params: { n: c.n(gap) } }
}

const trend: Builder = (c) => {
  const recent = playsWithin(c, c.today - MONTH_DAYS, c.today)
  const before = playsWithin(c, c.today - 2 * MONTH_DAYS, c.today - MONTH_DAYS)
  if (before < 20) return null
  const growth = Math.round((recent / before - 1) * 100)
  return growth >= MIN_SHARE ? { key: 'trend', params: { n: c.n(growth) } } : null
}

const byPlays = (c: Context, key: (song: Song) => string | null) =>
  largest(sumBy(c.played, key, (song) => song.playCount))

const topArtist: Builder = (c) => {
  const best = byPlays(c, (song) => song.artist)
  if (!best || best[1] < 10) return null
  return { key: 'topArtist', params: { artist: best[0], n: c.n(best[1]) } }
}

const artistShare: Builder = (c) => {
  const best = byPlays(c, (song) => song.artist)
  if (!best || c.totalPlays < 100) return null
  const oneIn = Math.round(c.totalPlays / best[1])
  if (oneIn < 2 || oneIn > 50) return null
  return { key: 'artistShare', params: { artist: best[0], n: String(oneIn) } }
}

const topSong: Builder = (c) => {
  const best = c.played.reduce<Song | null>(
    (held, song) => (!held || song.playCount > held.playCount ? song : held),
    null,
  )
  if (!best || best.playCount < 5) return null
  return { key: 'topSong', params: { title: best.title, n: c.n(best.playCount) } }
}

const topAlbum: Builder = (c) => {
  const best = byPlays(c, (song) => song.album)
  return best && best[1] >= 10 ? { key: 'topAlbum', params: { album: best[0] } } : null
}

const topGenre: Builder = (c) => {
  const seconds = sumBy(
    c.played,
    (song) => song.genre,
    (song) => song.duration * song.playCount,
  )
  const best = largest(seconds)
  if (!best) return null
  const all = [...seconds.values()].reduce((sum, value) => sum + value, 0)
  const share = Math.round((best[1] / all) * 100)
  return share >= MIN_SHARE
    ? { key: 'topGenre', params: { genre: best[0], n: String(share) } }
    : null
}

const credibleYear = (song: Song): boolean => (song.year ?? 0) >= OLDEST_CREDIBLE_YEAR

const decade: Builder = (c) => {
  const best = largest(
    sumBy(
      c.played.filter(credibleYear),
      (song) => String(Math.floor((song.year as number) / 10) * 10),
      (song) => song.playCount,
    ),
  )
  return best && best[1] >= 100 ? { key: 'decade', params: { decade: best[0] } } : null
}

const oldest: Builder = (c) => {
  const years = c.played.filter(credibleYear).map((song) => song.year as number)
  if (!years.length) return null
  return { key: 'oldest', params: { year: String(Math.min(...years)) } }
}

const unplayed: Builder = (c) => {
  const count = c.songs.length - c.played.length
  return count >= 2 ? { key: 'unplayed', params: { n: c.n(count) } } : null
}

const onceOnly: Builder = (c) => {
  const count = c.played.filter((song) => song.playCount === 1).length
  return count >= 2 ? { key: 'onceOnly', params: { n: c.n(count) } } : null
}

const unplayedAlbums: Builder = (c) => {
  const albums = sumBy(
    c.songs,
    (song) => song.albumId,
    (song) => song.playCount,
  )
  const count = [...albums.values()].filter((plays) => plays === 0).length
  return count >= 2 ? { key: 'unplayedAlbums', params: { n: c.n(count) } } : null
}

const longestSong: Builder = (c) => {
  const seconds = c.played.reduce((most, song) => Math.max(most, song.duration), 0)
  return seconds >= 600
    ? { key: 'longestSong', params: { n: c.n(Math.round(seconds / 60)) } }
    : null
}

const artistsHeard: Builder = (c) => {
  const count = new Set(c.played.map((song) => song.artist)).size
  return count >= 5 ? { key: 'artistsHeard', params: { n: c.n(count) } } : null
}

const average: Builder = (c) => {
  if (c.played.length < 20) return null
  const seconds = Math.round(c.played.reduce((sum, s) => sum + s.duration, 0) / c.played.length)
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return { key: 'average', params: { time } }
}

// Log and library by turns, so the days in a row do not sound alike.
const BUILDERS = [
  topArtist,
  thisMonth,
  unplayed,
  weekday,
  topSong,
  typicalDay,
  decade,
  late,
  onceOnly,
  bestDay,
  artistShare,
  lastWeek,
  longestSong,
  bestMonth,
  topGenre,
  today,
  unplayedAlbums,
  longestGap,
  oldest,
  early,
  topAlbum,
  daysActive,
  artistsHeard,
  trend,
  average,
]

export function statsLines({ songs, timestamps, today: now, locale }: StatsLineInput): StatsLine[] {
  const dates = timestamps.map((ts) => new Date(ts * 1000))
  const played = songs.filter((song) => song.playCount > 0)
  const context: Context = {
    today: dayIndex(now),
    thisMonth: monthKey(now),
    dates,
    days: playsPerDay(dates),
    songs,
    played,
    totalPlays: played.reduce((sum, song) => sum + song.playCount, 0),
    n: (value) => value.toLocaleString(locale),
    dayName: (index) =>
      new Date(index * DAY_MS).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      }),
    locale,
  }
  return BUILDERS.map((build) => build(context)).filter((line) => line !== null)
}

/** The same all day, so reloading does not swap it, and through every line
 * before the first comes back. */
export function lineOfTheDay(lines: StatsLine[], today: Date): StatsLine | null {
  return lines[dayIndex(today) % lines.length] ?? null
}
