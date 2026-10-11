/** Navidrome counts "in the last ..." in days only. The editor lets people
 * think in weeks, months and years, and saves the days they come to. A
 * month is 30 days and a year 365 - near enough for "not heard in half a
 * year", and the same numbers Navidrome's own docs use. */

export type DayUnit = 'days' | 'weeks' | 'months' | 'years'

export const DAYS_PER: Record<DayUnit, number> = { days: 1, weeks: 7, months: 30, years: 365 }

const LARGEST_FIRST: DayUnit[] = ['years', 'months', 'weeks', 'days']

/** The largest unit that divides `days` evenly, so 180 reads as 6 months
 * and 14 as 2 weeks, while 10 stays 10 days. */
export function splitDays(days: number): { amount: number; unit: DayUnit } {
  for (const unit of LARGEST_FIRST) {
    if (days > 0 && days % DAYS_PER[unit] === 0) return { amount: days / DAYS_PER[unit], unit }
  }
  return { amount: days, unit: 'days' }
}
