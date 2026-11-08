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
  /** A pressing's metal, which its disc takes on in place of the size's. */
  tier?: RecordTier
}

export const PLAYS_STEP = 1000

interface Ladder {
  rungs: number[]
  /** The distance between milestones past the last rung. */
  beyond: number
  /** From which value on each metal is awarded, highest first. */
  metals: [number, RecordTier][]
}

// Rungs that spread out as they rise, and diamond far enough away to mean
// something: 50 days of music is already 1,200 hours.
const HOURS_LADDER: Ladder = {
  rungs: [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000],
  beyond: 5000,
  metals: [
    [10000, 'diamond'],
    [2500, 'platinum'],
    [1000, 'gold'],
    [500, 'silver'],
    [0, 'bronze'],
  ],
}
const STREAK_LADDER: Ladder = {
  rungs: [7, 14, 30, 50, 100, 150, 200, 300, 365, 500, 750, 1000],
  beyond: 500,
  metals: [
    [500, 'diamond'],
    [300, 'platinum'],
    [100, 'gold'],
    [30, 'silver'],
    [0, 'bronze'],
  ],
}

function reachedRung({ rungs, beyond }: Ladder, value: number): number {
  const last = Math.max(...rungs)
  if (value >= last) return last + Math.floor((value - last) / beyond) * beyond
  return [...rungs].reverse().find((rung) => value >= rung) ?? 0
}

/** The highest milestone of each kind these figures have passed. */
export function reachedMilestones(values: MilestoneValues): MilestoneValues {
  return {
    plays: Math.floor(values.plays / PLAYS_STEP) * PLAYS_STEP,
    hours: reachedRung(HOURS_LADDER, values.hours),
    streak: reachedRung(STREAK_LADDER, values.streak),
    records: values.records,
  }
}

function sizeOfPlays(value: number): MilestoneSize {
  return value % 10000 === 0 ? 'l' : value % 5000 === 0 ? 'm' : 's'
}

const TIER_SIZE: Record<RecordTier, MilestoneSize> = {
  bronze: 's',
  silver: 's',
  gold: 'm',
  platinum: 'l',
  diamond: 'l',
}

/** The moment for a milestone of this kind at this value. */
export function milestoneMoment(kind: MilestoneKind, value: number): Moment {
  if (kind === 'plays') return { kind, value, size: sizeOfPlays(value) }
  const ladder = kind === 'hours' ? HOURS_LADDER : STREAK_LADDER
  const tier = ladder.metals.find(([from]) => value >= from)?.[1] ?? 'bronze'
  return { kind, value, tier, size: TIER_SIZE[tier] }
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
      return {
        kind: 'pressing',
        value: values.records,
        size: 'l',
        tier: recordDetails(values.records).tier,
      }
    }
  }
  const reached = reachedMilestones(values)
  let best: Moment | null = null
  for (const kind of KIND_ORDER) {
    const value = reached[kind]
    if (value <= (seen[kind] ?? 0)) continue
    const moment = milestoneMoment(kind, value)
    if (!best || SIZE_RANK[moment.size] > SIZE_RANK[best.size]) best = moment
  }
  return best
}

export const RECORD_GROOVES = 50
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

export type RecordTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'

// Ranked as sales certifications are. Early records run on small grooves so a
// new listener sees them fill, and the counts are picked so every record is
// full on a round total: bronze every 500 up to 2,000, then 3,000, 4,000,
// 5,000, 7,500, 10,000, 15,000, 20,000, 25,000, and diamonds at 50,000 and
// every 25,000 after it.
const DIAMOND_STEP = 500
const DIAMOND_PLAYS = DIAMOND_STEP * RECORD_GROOVES
const LADDER: { tier: RecordTier; step: number; records: number }[] = [
  { tier: 'bronze', step: 10, records: 4 },
  { tier: 'silver', step: 20, records: 3 },
  { tier: 'gold', step: 50, records: 2 },
  { tier: 'platinum', step: 100, records: 3 },
]
const LADDER_RECORDS = LADDER.flatMap(({ tier, step, records }) =>
  Array.from({ length: records }, () => ({ tier, step })),
)

// The total plays at which each of those is full: a record holds its own
// plays, so the next one starts again at the first groove.
let playsSoFar = 0
const LADDER_ENDS = LADDER_RECORDS.map(({ step }) => (playsSoFar += step * RECORD_GROOVES))
const LADDER_TOTAL = playsSoFar

function finishedRecords(plays: number): number {
  const record = LADDER_ENDS.findIndex((end) => plays < end)
  if (record !== -1) return record
  return LADDER_RECORDS.length + Math.floor((plays - LADDER_TOTAL) / DIAMOND_PLAYS)
}

function stepOf(record: number): number {
  return LADDER_RECORDS[record]?.step ?? DIAMOND_STEP
}

/** The total plays at which a record, counted from zero, is full. */
function endOf(record: number): number {
  return LADDER_ENDS[record] ?? LADDER_TOTAL + (record - LADDER_RECORDS.length + 1) * DIAMOND_PLAYS
}

/** What a record is, by its number counted from 1. */
export function recordDetails(number: number): {
  tier: RecordTier
  plays: number
  holds: number
  step: number
} {
  const record = number - 1
  return {
    tier: LADDER_RECORDS[record]?.tier ?? 'diamond',
    plays: endOf(record),
    holds: stepOf(record) * RECORD_GROOVES,
    step: stepOf(record),
  }
}

export function recordProgress(plays: number): RecordProgress {
  const finished = finishedRecords(plays)
  const step = stepOf(finished)
  const base = finished === 0 ? 0 : endOf(finished - 1)
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
  tier: RecordTier
  /** The total plays at which it filled up. */
  plays: number
  /** The plays on this record alone. */
  holds: number
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
  for (let number = 1; number <= finishedRecords(plays); number++) {
    const details = recordDetails(number)
    const earnedAt = timestamps[timestamps.length - 1 - (plays - details.plays)] ?? null
    const previous = records.at(-1)?.earnedAt ?? null
    records.push({
      number,
      ...details,
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
 * Hours and streaks have no place on a record measured in plays. */
export function milestoneRings(seenPlays: number, record: RecordProgress): MilestoneRing[] {
  const { base, step } = record
  const rings: MilestoneRing[] = []
  const first = (Math.floor(base / PLAYS_STEP) + 1) * PLAYS_STEP
  for (let value = first; value <= seenPlays; value += PLAYS_STEP) {
    const groove = Math.ceil((value - base) / step)
    if (groove > RECORD_GROOVES) break
    rings.push({ groove, value, size: sizeOfPlays(value) })
  }
  return rings
}
