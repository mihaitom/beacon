import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fractalZoom from '@/assets/milkdrop/presets/beacon-fractal-zoom.json'
import milkyWay from '@/assets/milkdrop/presets/beacon-milky-way.json'
import coverStage from '@/assets/milkdrop/presets/beacon-cover-stage.json'
import coverGlow from '@/assets/milkdrop/presets/beacon-cover-glow.json'
import type { SongAnalysis, SongAnalysisReply } from '@/services/connect/lights'
import { showBeat } from '../beatSignal'
import { SongBeats } from '../songBeats'

const getSongAnalysis = vi.hoisted(() => vi.fn<(songId: string) => Promise<SongAnalysisReply>>())
vi.mock('@/services/connect/lights', () => ({ getSongAnalysis }))

function analysis(times: number[], hits: number[] | null): SongAnalysisReply {
  const song: SongAnalysis = {
    energy_rate: 4,
    energy: [1],
    beats: times.length ? { times, downbeat: 0, period: 0.5 } : null,
    hits,
    heard_from: 0.5,
    rest_rate: 4,
    lull: null,
    swell: null,
  }
  return { status: 'ready', ...song }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('SongBeats', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getSongAnalysis.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('gives the analysed beat at the position, with its strength', async () => {
    getSongAnalysis.mockResolvedValue(analysis([1, 1.5, 2], [1, 0.8, 0.9]))
    const beats = new SongBeats()
    beats.follow('a')
    await settle()
    expect(getSongAnalysis).toHaveBeenCalledWith('a')
    expect(beats.at(0, 1.6, false)).toEqual({ index: 1, strength: 0.8 })
    expect(beats.at(0, 2.1, false)).toEqual({ index: 2, strength: 0.9 })
  })

  it('counts a beat not heard (a breakdown) as none', async () => {
    getSongAnalysis.mockResolvedValue(analysis([1, 1.5, 2], [1, 0.2, 1]))
    const beats = new SongBeats()
    beats.follow('a')
    await settle()
    expect(beats.at(0, 1.6, false)).toEqual({ index: 1, strength: 0 })
  })

  it('runs on between the positions the app reports', async () => {
    getSongAnalysis.mockResolvedValue(analysis([1, 1.5, 2], null))
    const beats = new SongBeats()
    beats.follow('a')
    await settle()
    expect(beats.at(1000, 1.4, true)!.index).toBe(0)
    // 200 ms on with no new position: past the beat at 1.5.
    expect(beats.at(1200, 1.4, true)!.index).toBe(1)
  })

  it('asks again while connect is still analysing', async () => {
    getSongAnalysis
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue(analysis([1, 1.5], null))
    const beats = new SongBeats()
    beats.follow('a')
    await settle()
    expect(beats.at(0, 1.2, false)).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(beats.at(0, 1.2, false)).toEqual({ index: 0, strength: 1 })
  })

  it('has nothing for a song without a beat, or one it could not analyse', async () => {
    getSongAnalysis.mockResolvedValueOnce(analysis([], null))
    const beats = new SongBeats()
    beats.follow('a')
    await settle()
    expect(beats.at(0, 1, false)).toBeNull()
    getSongAnalysis.mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    beats.follow('b')
    await settle()
    expect(beats.at(0, 1, false)).toBeNull()
  })

  it('drops a song left before its beats arrived', async () => {
    let answer: (reply: SongAnalysisReply) => void = () => {}
    getSongAnalysis.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    getSongAnalysis.mockResolvedValue({ status: 'pending' })
    const beats = new SongBeats()
    beats.follow('a')
    beats.follow('b')
    answer(analysis([1, 1.5], null))
    await settle()
    expect(beats.at(0, 1.2, false)).toBeNull()
  })
})

type Vars = Record<string, number>
type Equations = { init_eqs_str: string; frame_eqs_str: string }

/** Runs a preset's own equations a frame at a time, at 60 steps a second. */
function run(preset: Equations, bass = 1): () => Vars {
  const init = new Function('a', preset.init_eqs_str) as (a: Vars) => void
  const frame = new Function('a', preset.frame_eqs_str) as (a: Vars) => void
  const a: Vars = { bass, mid: 1, treb: 1, bass_att: 1, mid_att: 1, treb_att: 1, time: 1 }
  init(a)
  return () => {
    a.time = a.time! + 1 / 60
    frame(a)
    return a
  }
}

// What each of Beacon's own presets lights on the beat, 0 for nothing.
const PRESETS: [string, Equations, (a: Vars) => number][] = [
  ['Fractal Zoom', fractalZoom.preset, (a) => a.q10!],
  ['Milky Way', milkyWay.preset, (a) => a.q21!],
  ['Cover Glow', coverGlow.preset, (a) => a.q3!],
  // The ripple and the lift start at the beat's time.
  ['Cover Stage', coverStage.preset, (a) => Math.max(0, 1 - a.q4! * 2.2)],
]

describe.each(PRESETS)('%s on the analysed beat', (_, preset, lit) => {
  afterEach(() => showBeat(null))

  it('lights up on a beat heard, once', () => {
    const step = run(preset)
    showBeat({ index: 4, strength: 1 })
    const levels = Array.from({ length: 40 }, () => lit(step()))
    const peak = Math.max(...levels)
    expect(peak).toBeGreaterThan(0.2)
    // The same beat frame after frame: dying away, not lit again.
    expect(levels.at(-1)!).toBeLessThan(peak * 0.2)
  })

  it('takes nothing from the bass while it has the analysed beats', () => {
    const step = run(preset, 2)
    showBeat({ index: 4, strength: 0 })
    const levels = Array.from({ length: 10 }, () => lit(step()))
    expect(Math.max(...levels)).toBe(0)
  })

  it('goes by the bass without them', () => {
    const loud = run(preset, 2)
    expect(Math.max(...Array.from({ length: 10 }, () => lit(loud())))).toBeGreaterThan(0.2)
    const quiet = run(preset, 1)
    expect(Math.max(...Array.from({ length: 10 }, () => lit(quiet())))).toBe(0)
  })
})

describe('the Fractal Zoom on the analysed beat', () => {
  afterEach(() => showBeat(null))

  it('flashes as strongly as the beat is heard', () => {
    const step = run(fractalZoom.preset)
    showBeat({ index: 4, strength: 0.8 })
    expect(step().q10).toBeCloseTo(0.8)
    showBeat({ index: 5, strength: 1 })
    expect(step().q10).toBe(1)
  })
})
