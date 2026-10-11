/**
 * Which songs a set of smart playlist rules would pick, worked out from the
 * catalogue Beacon already holds: the editor's live preview, since Navidrome
 * cannot evaluate rules without saving them.
 *
 * An estimate, and it is honest about where. Every rule answers yes, no or
 * "cannot tell" for a song. "Cannot tell" comes from a rule about something
 * a Song does not carry (the album artist and the compilation flag, left
 * off Song on purpose - see subsonic/types.ts on RawSongDetail), from an
 * opaque rule, and from a playlist whose songs are not known. Those songs
 * are counted apart instead of being guessed in or out.
 *
 * Where a Song is thinner than Navidrome's own data, the comparison mirrors
 * Navidrome's SQL (`persistence/criteria_sql.go`) on what there is: `genre`
 * is a song's first genre, and the artist is read from its credit string.
 */

import { creditedNames } from '@/services/artistCredits'
import type { Song } from '@/types/library'
import { fieldDef, type RuleNode, type SmartRules, type TopNode } from './smartRules'

type Verdict = boolean | null

export interface PreviewContext {
  /** Milliseconds, for "in the last N days". */
  now: number
  /** The songs of the playlists rules refer to, by playlist id, where
   * known. A playlist missing here makes its rule "cannot tell". */
  playlistSongs?: ReadonlyMap<string, ReadonlySet<string>>
}

export interface Preview {
  /** Certain matches, sorted and cut to the limit. */
  songs: Song[]
  /** Certain matches before the limit. */
  matched: number
  /** Songs the preview cannot place either way. */
  uncertain: number
  /** When nothing matches: the top-level rule (or group) that on its own
   * matches nothing, so the editor can say which one emptied the list. */
  emptiedBy: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

function lower(values: (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => !!value).map((value) => value.toLowerCase())
}

/** A text field's values, lower case; undefined where a Song cannot say. */
function textValues(song: Song, field: string): string[] | undefined {
  switch (field) {
    case 'title':
      return lower([song.title])
    case 'artist':
      // Already lower case, and both the whole credit and each performer.
      return creditedNames(song.artist)
    case 'album':
      return lower([song.album])
    case 'genre':
      return lower([song.genre])
    case 'filetype':
      return lower([song.format])
    default:
      return undefined
  }
}

function numberValue(song: Song, field: string): number | null {
  switch (field) {
    case 'year':
      return song.year
    case 'rating':
      return song.rating
    case 'playcount':
      return song.playCount
    case 'duration':
      return song.duration
    case 'bpm':
      return song.bpm ?? null
    default:
      return null
  }
}

function dateValue(song: Song, field: string): string | null {
  const value = field === 'dateadded' ? song.added : song.lastPlayed
  return value ?? null
}

/** Navidrome compares dates as "YYYY-MM-DD" text against the stored
 * timestamp, so a whole day counts, not a 24-hour window. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function judgeText(values: string[], operator: string, wanted: string): boolean {
  const target = wanted.toLowerCase()
  switch (operator) {
    case 'is':
      return values.includes(target)
    case 'isNot':
      return !values.includes(target)
    case 'contains':
      return values.some((value) => value.includes(target))
    case 'notContains':
      return !values.some((value) => value.includes(target))
    case 'startsWith':
      return values.some((value) => value.startsWith(target))
    case 'endsWith':
      return values.some((value) => value.endsWith(target))
    default:
      return false
  }
}

function judgeRule(rule: RuleNode, song: Song, context: PreviewContext): Verdict {
  const field = fieldDef(rule.field)
  if (!field) return null
  const { operator, value } = rule

  if (field.kind === 'playlist') {
    const songs = context.playlistSongs?.get(String(value))
    if (!songs) return null
    return songs.has(song.id) === (operator === 'inPlaylist')
  }

  if (operator === 'isMissing' || operator === 'isPresent') {
    let missing: boolean | undefined
    if (field.kind === 'text') {
      const values = textValues(song, field.key)
      missing = values === undefined ? undefined : values.length === 0
    } else if (field.kind === 'number') {
      missing = numberValue(song, field.key) === null
    }
    if (missing === undefined) return null
    return missing === (operator === 'isMissing')
  }

  switch (field.kind) {
    case 'text': {
      const values = textValues(song, field.key)
      if (values === undefined) return null
      return judgeText(values, operator, String(value))
    }
    case 'number': {
      const actual = numberValue(song, field.key)
      // SQL: a comparison with NULL is never true.
      if (actual === null) return false
      if (operator === 'inTheRange') {
        const [from, to] = value as [number, number]
        return actual >= from && actual <= to
      }
      const wanted = value as number
      if (operator === 'is') return actual === wanted
      if (operator === 'isNot') return actual !== wanted
      if (operator === 'gt') return actual > wanted
      return actual < wanted
    }
    case 'date': {
      const actual = dateValue(song, field.key)
      if (operator === 'inTheLast' || operator === 'notInTheLast') {
        const since = dayOf(context.now - (value as number) * DAY_MS)
        const within = actual !== null && actual > since
        // notInTheLast includes what never happened at all (`IS NULL`).
        return operator === 'inTheLast' ? within : !within
      }
      if (actual === null) return false
      return operator === 'before' ? actual < String(value) : actual > String(value)
    }
    case 'boolean':
      if (field.key === 'loved') return song.starred === value
      return null
  }
}

function judge(node: TopNode, song: Song, context: PreviewContext): Verdict {
  if (node.type === 'opaque') return null
  if (node.type === 'rule') return judgeRule(node, song, context)
  return combine(node.conjunction, node.children, song, context)
}

/** Three-valued all/any: a definite answer wins over "cannot tell" only
 * where it settles the question on its own. */
function combine(
  conjunction: 'all' | 'any',
  nodes: readonly TopNode[],
  song: Song,
  context: PreviewContext,
): Verdict {
  let unsure = false
  for (const node of nodes) {
    const verdict = judge(node, song, context)
    if (verdict === null) unsure = true
    else if (verdict === (conjunction === 'any')) return verdict
  }
  return unsure ? null : conjunction === 'all'
}

function sortKey(song: Song, field: string): string | number | null {
  const def = fieldDef(field)
  if (!def) return null
  switch (def.kind) {
    case 'text':
      return textValues(song, field)?.[0] ?? null
    case 'number':
      return numberValue(song, field)
    case 'date':
      return dateValue(song, field)
    case 'boolean':
      return field === 'loved' ? Number(song.starred) : null
    default:
      return null
  }
}

/** Stable while the rules are being edited, so "random" does not reshuffle
 * the preview on every keystroke. */
function scatter(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return hash
}

function sorted(songs: Song[], rules: SmartRules): Song[] {
  // Navidrome's own default when nothing is given.
  const sort =
    rules.sort && 'field' in rules.sort ? rules.sort : { field: 'title', descending: false }
  if (sort.field === 'random') return [...songs].sort((a, b) => scatter(a.id) - scatter(b.id))
  const direction = sort.descending ? -1 : 1
  return [...songs].sort((a, b) => {
    const left = sortKey(a, sort.field)
    const right = sortKey(b, sort.field)
    // Songs without a value go last either way.
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1
    return (left < right ? -1 : left > right ? 1 : 0) * direction
  })
}

export function previewRules(
  rules: SmartRules,
  catalogue: readonly Song[],
  context: PreviewContext,
): Preview {
  const matches: Song[] = []
  let uncertain = 0
  for (const song of catalogue) {
    const verdict = combine(rules.conjunction, rules.children, song, context)
    if (verdict === true) matches.push(song)
    else if (verdict === null) uncertain++
  }

  let emptiedBy: number | null = null
  if (matches.length === 0 && uncertain === 0) {
    const culprit = rules.children.find(
      (node) => !catalogue.some((song) => judge(node, song, context) !== false),
    )
    emptiedBy = culprit?.key ?? null
  }

  const ordered = sorted(matches, rules)
  return {
    songs: rules.limit !== null ? ordered.slice(0, rules.limit) : ordered,
    matched: matches.length,
    uncertain,
    emptiedBy,
  }
}
