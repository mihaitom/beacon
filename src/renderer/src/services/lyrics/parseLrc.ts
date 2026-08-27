import type { StructuredLyrics } from '@/services/subsonic/types'

export interface LyricLine {
  time: number
  text: string
}

export interface ParsedLyrics {
  synced: boolean
  lines: LyricLine[]
  /** Songwriter/producer credits some sources put at the top of a sheet —
   * kept out of `lines` and shown next to the source instead (see
   * splitOffCredits). Empty for the vast majority of lyrics. */
  credits: string[]
}

// One leading LRC timestamp tag. Matched in a loop (not a single regex over
// the whole line) because a line can carry more than one tag — LRC's
// convention for a repeated line (e.g. a chorus) is `[00:10.00][00:40.00]text`,
// one shared line of text sung at several timestamps.
//
// The trailing `-N` is a suffix some sources append (`[00:00.00-1]`, seen
// in the wild 2026-08-27). Whatever it numbers, the timestamp in front of
// it is a perfectly ordinary one — and refusing to match it was worse than
// ignoring it: the line then counted as untimed and kept the whole tag as
// part of its text, which is how "[00:00.00-1] 作词 : ..." ended up on
// screen as if it were a lyric.
//
// Minutes are 1-3 digits, not exactly 2: a track past an hour, or a source
// that writes them unpadded, is still a valid timestamp.
const LEADING_TAG = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?(?:-\d+)?\]/

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
    return { synced: true, ...splitOffCredits(synced.sort((a, b) => a.time - b.time)) }
  }

  const plain = rawLines.map((line) => line.trim()).filter((line) => line.length > 0)
  return { synced: false, ...splitOffCredits(plain.map((text) => ({ time: 0, text }))) }
}

/** Credits some providers put at the top of a lyric sheet: "作曲 : ...",
 * "制作人 : ...", "Written by ...". NetEase does it on essentially every
 * song (verified 2026-08-27 across four).
 *
 * They are timed at the very start and packed together — four of them on
 * "Bohemian Rhapsody" between 0.000s and 0.075s, so each would be on
 * screen for 25 milliseconds before the next replaced it. Unreadable in
 * the karaoke flow, and they are the songwriters, composer and producer
 * being named, so they are moved rather than dropped: out of the lines
 * and in beside the source, where they stay legible for as long as the
 * song plays.
 *
 * Only ever taken from the *front* of a sheet, stopping at the first line
 * that is actually sung: a colon or the word "by" can legitimately appear
 * in a lyric, and no rule here should be able to pull real lines out of
 * the middle of a song. */
const CREDIT_PREFIX = /^\s*(?:[^:\s][^:]{0,29})\s:\s/
const CREDIT_BY =
  /^\s*(?:lyrics?|music|composed|written|arranged|produced|mixed|mastered|vocals?)\s+by\b/i

function isCreditLine(text: string): boolean {
  return CREDIT_PREFIX.test(text) || CREDIT_BY.test(text)
}

/** Merges credits naming the same people under one line: a song written
 * and composed by the same person arrives as two lines with identical
 * halves after the colon ("作词 : X", "作曲 : X"), which reads as a
 * duplicate. Both roles are kept — they are what the credit is for — so
 * the result is "作词/作曲 : X" rather than either one dropped. */
function mergeSameCredits(credits: string[]): string[] {
  const byValue = new Map<string, { roles: string[]; whole: string }>()
  for (const credit of credits) {
    const separator = credit.indexOf(' : ')
    if (separator === -1) {
      if (!byValue.has(credit)) byValue.set(credit, { roles: [], whole: credit })
      continue
    }
    const role = credit.slice(0, separator).trim()
    const value = credit.slice(separator + 3).trim()
    const existing = byValue.get(value)
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role)
    } else {
      byValue.set(value, { roles: [role], whole: credit })
    }
  }
  return [...byValue.entries()].map(([value, { roles, whole }]) =>
    roles.length > 0 ? `${roles.join('/')} : ${value}` : whole,
  )
}

function splitOffCredits(lines: LyricLine[]): { lines: LyricLine[]; credits: string[] } {
  let count = 0
  while (count < lines.length && isCreditLine(lines[count]!.text)) count += 1
  if (count === 0) return { lines, credits: [] }
  // A sheet that is credits all the way down is one some sources return
  // for a song they have no words for (NetEase does, verified 2026-08-27).
  // Emptying it out is right: two names are not a lyric sheet, and the
  // caller treats "no lines" as nothing found, which is the truth.
  return {
    lines: lines.slice(count),
    credits: mergeSameCredits(lines.slice(0, count).map((line) => line.text)),
  }
}

/** Lyrics read out of a file's own tags arrive with the tag's structure
 * still in them: the last line is the frame's NUL terminator, which every
 * server tested passes straight through (Navidrome and Jellyfin alike,
 * checked against both on 2026-08-27). Stripped here rather than in one
 * server's adapter, since the cause is the tag, not the server.
 *
 * What is left of that line — nothing — is deliberately kept as a line of
 * its own. A timed lyric line with no text is how LRC says "nobody is
 * singing from here on", and providers emit them mid-song for
 * instrumental breaks (seen in lrclib's and NetEase's own sheets).
 * Dropping them would leave the previous line highlighted through the
 * whole gap: in "Blinding Lights", a single "Yeah" would stay lit from
 * 0:13 to 0:27.
 *
 * replaceAll over a regex on purpose — a literal NUL inside a regex is
 * exactly what no-control-regex exists to flag. */
function cleanLyricText(value: string): string {
  return value.replaceAll('\u0000', '').trim()
}

/** Converts OpenSubsonic's getLyricsBySongId.view shape (already split
 * into lines with millisecond timestamps) into the same ParsedLyrics
 * shape parseLyrics() produces from raw LRC text, so the rest of the app
 * doesn't need to care which source a song's lyrics came from. */
export function fromStructuredLyrics(lyrics: StructuredLyrics): ParsedLyrics {
  if (lyrics.synced) {
    const lines = lyrics.line
      .filter((line): line is { start: number; value: string } => line.start != null)
      .map((line) => ({ time: line.start / 1000, text: cleanLyricText(line.value) }))
    // Nothing but blanks is not a lyric sheet — answering with those would
    // stop the caller from falling back to a third-party lookup (see
    // stores/lyrics.ts) and leave an empty panel instead.
    if (!lines.some((line) => line.text.length > 0)) {
      return { synced: true, lines: [], credits: [] }
    }
    // Lyrics copied into a file's tags carry whatever the source put at the
    // top, credits included.
    return { synced: true, ...splitOffCredits(lines.sort((a, b) => a.time - b.time)) }
  }
  const lines = lyrics.line
    .map((line) => cleanLyricText(line.value))
    .filter((value) => value.length > 0)
    .map((text) => ({ time: 0, text }))
  return { synced: false, ...splitOffCredits(lines) }
}
