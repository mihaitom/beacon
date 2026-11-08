/** The numbers the Stats page celebrates, and how far the hero's record has
 * got. */

export interface MilestoneValues {
  plays: number
  hours: number
  streak: number
  /** Plays one groove stands for. Absent on what was saved before it existed. */
  step?: number
}

export type MilestoneKind = 'plays' | 'hours' | 'streak'
export type MilestoneSize = 's' | 'm' | 'l'

export interface Moment {
  /** A pressing: the record has moved on to bigger grooves. */
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
    step: values.step,
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
  // Ahead of any other: the record has just lost half its filled grooves, and
  // this is what says why.
  if (seen.step && values.step && values.step > seen.step) {
    return { kind: 'pressing', value: values.step, size: 'l' }
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
  /** Grooves already finished, from the outer edge in. */
  done: number
  /** How far along the next groove is, 0 to 1. */
  progress: number
  next: number
  remaining: number
}

const RECORD_STEPS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000]
const LARGEST_RECORD_STEP = 50000
// Below the 40 grooves, so the record still has room left when a step ends.
const MAX_FILLED_GROOVES = 34

/** The step grows with the listener, so a new one sees grooves fill and a
 * long-time one does not run off the end of the record. */
export function recordProgress(plays: number): RecordProgress {
  const step =
    RECORD_STEPS.find((candidate) => plays / candidate < MAX_FILLED_GROOVES) ?? LARGEST_RECORD_STEP
  const done = Math.min(Math.floor(plays / step), RECORD_GROOVES - 1)
  const next = (Math.floor(plays / step) + 1) * step
  return { step, done, progress: (plays % step) / step, next, remaining: next - plays }
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
  const from = (n - 1) * record.step
  return {
    n,
    from,
    to: n * record.step,
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
 * Hours and streaks have no place on a record measured in plays. With a large
 * step several share a groove, which then shows the biggest of them. */
export function milestoneRings(seenPlays: number, step: number): MilestoneRing[] {
  const rings = new Map<number, MilestoneRing>()
  for (let value = PLAYS_STEP; value <= seenPlays; value += PLAYS_STEP) {
    const groove = Math.ceil(value / step)
    if (groove > RECORD_GROOVES) break
    const size = sizeOf('plays', value)
    const held = rings.get(groove)
    if (!held || SIZE_RANK[size] >= SIZE_RANK[held.size]) {
      rings.set(groove, { groove, value, size })
    }
  }
  return [...rings.values()]
}
