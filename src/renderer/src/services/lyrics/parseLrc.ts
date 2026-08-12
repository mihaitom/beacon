import type { StructuredLyrics } from '@/services/subsonic/types'

export interface LyricLine {
  time: number
  text: string
}

export interface ParsedLyrics {
  synced: boolean
  lines: LyricLine[]
}

// One leading LRC timestamp tag. Matched in a loop (not a single regex over
// the whole line) because a line can carry more than one tag — LRC's
// convention for a repeated line (e.g. a chorus) is `[00:10.00][00:40.00]text`,
// one shared line of text sung at several timestamps.
const LEADING_TAG = /^\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/

function parseLine(line: string): LyricLine[] {
  let rest = line
  const times: number[] = []
  let match: RegExpExecArray | null
  while ((match = LEADING_TAG.exec(rest))) {
    const [, minutes, seconds, fraction] = match
    // LRC's fraction is centiseconds (2 digits) by convention, though some
    // sources emit 3 (milliseconds) — pad/truncate to milliseconds either
    // way before dividing, rather than assuming a fixed digit count.
    const millis = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0
    times.push(Number(minutes) * 60 + Number(seconds) + millis / 1000)
    rest = rest.slice(match[0].length)
  }
  const text = rest.trim()
  return times.map((time) => ({ time, text }))
}

/** Parses the raw string /lyrics/auto returns — LRC-formatted
 * (`[mm:ss.xx]text`, one or more leading tags per line) when a synced match
 * was found, otherwise plain text. Nothing in the API response says which;
 * this is the detection. Non-timestamp LRC metadata lines (`[ar:Artist]`,
 * `[ti:Title]`, ...) simply produce no tag match and are dropped once real
 * timed lines exist — same as any other unmatched line. */
export function parseLyrics(raw: string): ParsedLyrics {
  const rawLines = raw.split(/\r?\n/)
  const synced = rawLines.flatMap(parseLine)

  if (synced.length > 0) {
    return { synced: true, lines: synced.sort((a, b) => a.time - b.time) }
  }

  const plain = rawLines.map((line) => line.trim()).filter((line) => line.length > 0)
  return { synced: false, lines: plain.map((text) => ({ time: 0, text })) }
}

/** Converts OpenSubsonic's getLyricsBySongId.view shape (already split
 * into lines with millisecond timestamps) into the same ParsedLyrics
 * shape parseLyrics() produces from raw LRC text, so the rest of the app
 * doesn't need to care which source a track's lyrics came from. */
export function fromStructuredLyrics(lyrics: StructuredLyrics): ParsedLyrics {
  if (lyrics.synced) {
    const lines = lyrics.line
      .filter((line): line is { start: number; value: string } => line.start != null)
      .map((line) => ({ time: line.start / 1000, text: line.value }))
    return { synced: true, lines: lines.sort((a, b) => a.time - b.time) }
  }
  const lines = lyrics.line
    .map((line) => line.value.trim())
    .filter((value) => value.length > 0)
    .map((text) => ({ time: 0, text }))
  return { synced: false, lines }
}
