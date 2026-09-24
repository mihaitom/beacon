/** A playlist's or album's running time as "58 min" / "1 hr 12 min", from
 * its tracks' durations in seconds; empty when there is nothing to add up.
 * Rounded to whole minutes before splitting into hours, so 59:40 reads as
 * an hour rather than "60 min". */
export function formatTotalDuration(
  seconds: number,
  t: (key: string, values: Record<string, number>) => string,
): string {
  if (!seconds) return ''
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return t('playlists.durationHours', { hours, minutes })
  return t('playlists.durationMinutes', { minutes })
}
