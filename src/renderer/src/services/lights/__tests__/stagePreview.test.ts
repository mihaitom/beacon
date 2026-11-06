// The preview has to read a song the way connect does (lights/analysis.py's
// SongLights, lights/controller.py's rotation()), or the dialog shows
// lights the room never does.
import { describe, expect, it } from 'vitest'
import type { SongAnalysis } from '@/services/connect/lights'
import {
  MADE_UP_SONG,
  analysedSong,
  hexToRgb,
  playbackClock,
  previewFrame,
  previewTurn,
  rgbToHex,
  rotation,
} from '../stagePreview'

describe('rotation', () => {
  it('starts at the picture colour, the others evenly round the wheel', () => {
    expect(rotation([255, 0, 0], 3, 0).map(rgbToHex)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })

  it('turns by the given share of the wheel', () => {
    expect(rotation([255, 0, 0], 3, 1 / 3).map(rgbToHex)).toEqual(['#00ff00', '#0000ff', '#ff0000'])
    expect(rotation([255, 0, 0], 3, 1).map(rgbToHex)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })
})

describe('previewTurn', () => {
  it('moves on with the beats and stands still through the breakdown', () => {
    // 120 BPM: a beat every half second; beats 24-31 of every 32 are the
    // breakdown.
    expect(previewTurn(MADE_UP_SONG, 0.1)).toBe(0)
    expect(previewTurn(MADE_UP_SONG, 5.1)).toBeGreaterThan(previewTurn(MADE_UP_SONG, 4.1))
    expect(previewTurn(MADE_UP_SONG, 15.9)).toBe(previewTurn(MADE_UP_SONG, 12.1))
    expect(previewTurn(MADE_UP_SONG, 16.1)).toBeGreaterThan(previewTurn(MADE_UP_SONG, 15.9))
  })

  it('takes only the hue of the start colour', () => {
    expect(rgbToHex(rotation(hexToRgb('#802020'), 1, 0)[0]!)).toBe('#ff0000')
  })
})

const ANALYSIS: SongAnalysis = {
  energy_rate: 4,
  energy: [0, 0.5, 1],
  beats: { times: [1, 1.5, 2, 2.5], downbeat: 1, period: 0.5 },
  hits: [1, 0.1, 0.9, 1],
  heard_from: 0.5,
  rest_rate: 20,
  lull: null,
  swell: null,
}

describe('analysedSong', () => {
  const song = analysedSong(ANALYSIS)

  it('finds the last beat and the time since it', () => {
    expect(song.beatAt(1.6)).toEqual([1, expect.closeTo(0.1)])
    expect(song.beatAt(2)).toEqual([2, 0])
  })

  it('counts on at the tempo before the first beat and after the last', () => {
    expect(song.beatAt(0.7)).toEqual([-1, expect.closeTo(0.2)])
    expect(song.beatAt(3.1)).toEqual([4, expect.closeTo(0.1)])
  })

  it('counts only the beats heard, and every one past the analysed part', () => {
    expect([0, 1, 2, 3].map((b) => song.heardBeats(b))).toEqual([1, 1, 2, 3])
    expect(song.heardBeats(5)).toBe(5)
    expect(song.hit(1)).toBeCloseTo(0.1)
    expect(song.hit(9)).toBe(1)
  })

  it('puts the bar on the downbeat connect found', () => {
    expect([0, 1, 5, -3].map((b) => song.isDownbeat(b))).toEqual([false, true, true, true])
  })

  it('reads the loudness at its own rate and holds the last value', () => {
    expect(song.energyAt(0.3)).toBe(0.5)
    expect(song.energyAt(60)).toBe(1)
  })

  it('a song without a beat follows its loudness alone', () => {
    const still = analysedSong({ ...ANALYSIS, beats: null, hits: null })
    expect(still.beatAt(1)).toBeNull()
    const quiet = previewFrame(0, still, 'party', [[255, 0, 0]], 2, 1)
    const loud = previewFrame(0.6, still, 'party', [[255, 0, 0]], 2, 1)
    expect(loud[0]!.level).toBeGreaterThan(quiet[0]!.level)
    expect(previewTurn(still, 5)).toBe(0)
  })

  it('a beat flashes as strongly as it is heard', () => {
    const flash = (beat: number) => {
      const level = (t: number) => previewFrame(t, song, 'pulse', [[255, 0, 0]], 1, 1)[0]!.level
      return level(beat) - level(beat + 0.45)
    }
    expect(flash(2.5)).toBeGreaterThan(5 * flash(1.5))
  })

  it('a breakdown stays lit, breathes and does not flash', () => {
    const resting = (lull: number, swell: number) =>
      analysedSong({
        ...ANALYSIS,
        energy: [0.5],
        hits: [0.4, 0.4, 0.4, 0.4],
        lull: Array(100).fill(lull),
        swell: Array(100).fill(swell),
      })
    const level = (lull: number, swell: number) =>
      previewFrame(1.02, resting(lull, swell), 'party', [[255, 0, 0]], 1, 1)[0]!.level
    expect(level(1, 0)).toBeCloseTo(0.16 + 0.44 * 0.5)
    expect(level(1, 1)).toBeCloseTo(0.16 + 0.44 * 0.5 + 0.2)
    // Outside a breakdown a faint beat flashes as before, and nothing breathes.
    expect(level(0, 1)).toBeGreaterThan(0.06 + 0.2 * 0.5)
    expect(level(0, 1)).toBe(level(0, 0))
  })

  it('a chase before the first beat counts round from the last lamp', () => {
    // Beat -1, as connect's Python counts it round: the third of three.
    const frame = previewFrame(0.55, song, 'chase', [[255, 0, 0]], 3, 1)
    expect(frame[2]!.level).toBeGreaterThan(frame[0]!.level)
    expect(frame[2]!.level).toBeGreaterThan(frame[1]!.level)
  })
})

describe('playbackClock', () => {
  it('runs on between the positions the app reports', () => {
    const clock = playbackClock()
    expect(clock(1000, 10, true)).toBe(10)
    expect(clock(1100, 10, true)).toBeCloseTo(10.1)
    expect(clock(1250, 10.25, true)).toBe(10.25)
  })

  it('stands still while paused', () => {
    const clock = playbackClock()
    clock(1000, 10, false)
    expect(clock(3000, 10, false)).toBe(10)
  })

  it('does not run away when the reports stop coming', () => {
    const clock = playbackClock()
    clock(1000, 10, true)
    expect(clock(9000, 10, true)).toBe(11)
  })
})
