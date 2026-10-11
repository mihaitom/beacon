/** Navidrome compares dates as "YYYY-MM-DD" text (see preview.ts); the
 * date picker speaks Date objects. Both directions in local time - a date
 * someone picks is a calendar day, and reading it through UTC would move it
 * to the day before anywhere east of Greenwich. */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

export function dayToDate(day: string): Date | null {
  const match = DAY.exec(day)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function dateToDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
