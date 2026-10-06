const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "3 days ago", "yesterday", "just now" for a time in ms - in the largest
 * unit that has at least one whole step in it. Empty for NaN, so a date
 * that could not be parsed simply says nothing. */
export function timeAgo(time: number, now: number, locale: string): string {
  if (Number.isNaN(time)) return ''
  const seconds = (now - time) / 1000
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of RELATIVE_STEPS) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit)
  }
  return format.format(0, 'minute')
}
