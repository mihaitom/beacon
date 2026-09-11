/**
 * How one track's raw figures are written out - shared by the track-info
 * dialog (services/library/songDetails.ts) and the song table's columns
 * (services/library/songColumns.ts), so a file size or a sample rate reads
 * the same in both places rather than being formatted twice, slightly
 * differently.
 *
 * Every one of these takes what the server actually sent (which is often
 * nothing) and answers null for it, rather than inventing a zero.
 */

export function formatDuration(seconds?: number | null): string | null {
  if (seconds == null) return null
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** Binary MB, the unit a file manager shows for the same file. Two
 * decimals below 10 MB so a short track is not just "4 MB". */
export function formatSize(bytes?: number | null): string | null {
  if (bytes == null) return null
  const mb = bytes / 1024 / 1024
  if (mb < 10) return `${mb.toFixed(2)} MB`
  return `${Math.round(mb)} MB`
}

export function formatSampleRate(hz?: number | null): string | null {
  if (!hz) return null
  // 44100 reads as 44.1 kHz, 48000 as 48 kHz - trailing zeroes dropped
  // rather than always printing one decimal.
  return `${String(Number((hz / 1000).toFixed(1)))} kHz`
}

/** Timestamps come through as ISO strings. Shown in the reader's own
 * locale, and left out entirely when the server sent something unparseable
 * rather than printing "Invalid Date". */
export function formatTimestamp(value: string | null | undefined, locale: string): string | null {
  const date = parseDate(value)
  return date ? date.toLocaleString(locale) : null
}

/** The same timestamp without its time of day - what a table column has
 * room for, where the dialog's row has the width for both. */
export function formatDate(value: string | null | undefined, locale: string): string | null {
  const date = parseDate(value)
  return date ? date.toLocaleDateString(locale) : null
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
