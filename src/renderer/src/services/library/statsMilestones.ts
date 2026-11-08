/** The numbers the Stats page celebrates, and how far the hero's record has
 * got. */

export interface MilestoneValues {
  plays: number
  hours: number
  streak: number
  /** Records filled. Absent on what was saved before records were counted. */
  records?: number
}

export type MilestoneKind = 'plays' | 'hours' | 'streak'
export type MilestoneSize = 's' | 'm' | 'l'

export interface Moment {
  /** A pressing: a record is full and goes on the shelf. */
  kind: MilestoneKind | 'pressing'
  value: number
  size: MilestoneSize
}

export const PLAYS_STEP = 1000
const HOURS_STEP = 100
const EARLY_STREAKS = [7, 14, 30, 50]
const LONG_STREAK_STEP = 100

function reachedStreak(days: number): number {
  if (days >= LONG_STREAK_STEP) return Math.floor(days / LONG_STREAK_STEP) * LONG_STREAK_STEP
  return [...EARLY_STREAKS].reverse().find((step) => days >= step) ?? 0
}

/** The highest milestone of each kind these figures have passed. */
export function reachedMilestones(values: MilestoneValues): MilestoneValues {
  return {
    plays: Math.floor(values.plays / PLAYS_STEP) * PLAYS_STEP,
    hours: Math.floor(values.hours / HOURS_STEP) * HOURS_STEP,
    streak: reachedStreak(values.streak),
    records: values.records,
  }
}

function sizeOf(kind: MilestoneKind, value: number): MilestoneSize {
  if (kind === 'streak') return value >= 100 ? 'l' : value >= 30 ? 'm' : 's'
  const [large, medium] = kind === 'plays' ? [10000, 5000] : [1000, 500]
  return value % large === 0 ? 'l' : value % medium === 0 ? 'm' : 's'
}

const SIZE_RANK: Record<MilestoneSize, number> = { s: 0, m: 1, l: 2 }
// When two are equally big, the order they are named in here decides.
const KIND_ORDER: MilestoneKind[] = ['hours', 'plays', 'streak']

/** The one milestone worth celebrating on this visit, if any: several passed
 * since the last one are one moment, the biggest. `seen` is null on the first
 * visit, which only sets the baseline, or a listener would be congratulated
 * on years of plays that were already there. */
export function nextMoment(seen: MilestoneValues | null, values: MilestoneValues): Moment | null {
  if (!seen) return null
  // Ahead of any other: the turntable has just changed record, and this is
  // what says why.
  if (seen.records !== undefined && values.records !== undefined) {
    if (values.records > seen.records) {
      return { kind: 'pressing', value: values.records, size: 'l' }
    }
  }
  const reached = reachedMilestones(values)
  let best: Moment | null = null
  for (const kind of KIND_ORDER) {
    const value = reached[kind]
    if (value <= (seen[kind] ?? 0)) continue
    const size = sizeOf(kind, value)
    if (!best || SIZE_RANK[size] > SIZE_RANK[best.size]) best = { kind, value, size }
  }
  return best
}

export const RECORD_GROOVES = 40
// The record's geometry, in the units of its SVG.
export const RECORD_OUTER = 250
export const RECORD_INNER = 96
const GROOVE_GAP = (RECORD_OUTER - RECORD_INNER) / (RECORD_GROOVES - 1)

export function grooveRadius(n: number): number {
  return RECORD_OUTER - (n - 1) * GROOVE_GAP
}

/** The groove nearest to a distance from the spindle, null off the grooves.
 * By distance rather than by hitting a line: a groove is a few pixels wide. */
export function grooveAtRadius(radius: number): number | null {
  if (radius > RECORD_OUTER + GROOVE_GAP || radius < RECORD_INNER - GROOVE_GAP) return null
  const n = Math.round((RECORD_OUTER - radius) / GROOVE_GAP) + 1
  return Math.min(RECORD_GROOVES, Math.max(1, n))
}

export interface RecordProgress {
  /** Plays one groove stands for. */
  step: number
  /** The plays at which this record's first groove begins. */
  base: number
  /** Grooves already finished, from the outer edge in. */
  done: number
  progress: number
  next: number
  remaining: number
  /** Records already full, the ones on the shelf. */
  finished: number
}

// Early records run on small grooves so a new listener sees them fill. Past
// the largest step a groove stays the same and only the records add up: a
// groove worth thousands of plays no longer moves.
const LARGEST_STEP = 1000
const RECORD_STEPS = [50, 100, 250, 500, LARGEST_STEP]
const LARGEST_RECORD_PLAYS = LARGEST_STEP * RECORD_GROOVES

function finishedRecords(plays: number): number {
  if (plays >= LARGEST_RECORD_PLAYS) {
    return RECORD_STEPS.length - 1 + Math.floor(plays / LARGEST_RECORD_PLAYS)
  }
  return RECORD_STEPS.findIndex((step) => plays < step * RECORD_GROOVES)
}

function stepOf(record: number): number {
  return RECORD_STEPS[record] ?? LARGEST_STEP
}

/** The total plays at which a record, counted from zero, is full. */
function endOf(record: number): number {
  if (record < RECORD_STEPS.length) return stepOf(record) * RECORD_GROOVES
  return (record - RECORD_STEPS.length + 2) * LARGEST_RECORD_PLAYS
}

export function recordProgress(plays: number): RecordProgress {
  const finished = finishedRecords(plays)
  const step = stepOf(finished)
  // The early records are the same plays on a finer scale, so their grooves
  // count from zero; only the ones after them start empty.
  const base = finished < RECORD_STEPS.length ? 0 : endOf(finished - 1)
  const done = Math.floor((plays - base) / step)
  const next = base + (done + 1) * step
  return {
    step,
    base,
    done,
    progress: ((plays - base) % step) / step,
    next,
    remaining: next - plays,
    finished,
  }
}

export interface PressedRecord {
  /** Counted from 1. */
  number: number
  plays: number
  step: number
  /** When it filled up, null when that lies before the log begins. */
  earnedAt: number | null
  /** How long it took after the one before, when both dates are known. */
  tookSeconds: number | null
}

/** The full records, dated by counting back through the log: the play that
 * filled one is as many from the end as plays have been added since. */
export function pressedRecords(plays: number, timestamps: number[]): PressedRecord[] {
  const records: PressedRecord[] = []
  for (let record = 0; record < finishedRecords(plays); record++) {
    const end = endOf(record)
    const earnedAt = timestamps[timestamps.length - 1 - (plays - end)] ?? null
    const previous = records.at(-1)?.earnedAt ?? null
    records.push({
      number: record + 1,
      plays: end,
      step: stepOf(record),
      earnedAt,
      tookSeconds: earnedAt !== null && previous !== null ? earnedAt - previous : null,
    })
  }
  return records
}

export interface GrooveInfo {
  n: number
  from: number
  to: number
  state: 'played' | 'current' | 'ahead'
  /** Plays still missing to get here, for a groove ahead. */
  left: number
}

export function grooveInfo(record: RecordProgress, n: number): GrooveInfo {
  const current = record.done + 1
  const plays = record.next - record.remaining
  const from = record.base + (n - 1) * record.step
  return {
    n,
    from,
    to: record.base + n * record.step,
    state: n < current ? 'played' : n === current ? 'current' : 'ahead',
    left: Math.max(0, from - plays),
  }
}

export interface MilestoneRing {
  groove: number
  value: number
  size: MilestoneSize
}

/** The plays milestones already celebrated, on the groove each happened in.
 * Hours and streaks have no place on a record measured in plays. Once every
 * groove holds a thousand plays only the rounder ones are marked, or each
 * groove would be a ring. */
export function milestoneRings(seenPlays: number, record: RecordProgress): MilestoneRing[] {
  const { base, step } = record
  const rings: MilestoneRing[] = []
  for (let value = base + PLAYS_STEP; value <= seenPlays; value += PLAYS_STEP) {
    const groove = Math.ceil((value - base) / step)
    if (groove > RECORD_GROOVES) break
    const size = sizeOf('plays', value)
    if (step < PLAYS_STEP || size !== 's') rings.push({ groove, value, size })
  }
  return rings
}
