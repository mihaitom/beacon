import { describe, expect, it } from 'vitest'
import { LineLayer, MAX_LINE_POINTS, TILES_X, TILES_Y, TILE_ENTRIES } from '../lineLayer'

// 10 x 10 pixels a tile.
const W = TILES_X * 10
const H = TILES_Y * 10
type Point = [x: number, y: number, width?: number, r?: number]

/** The preset's buffer, from points in pixels. */
function buffer(points: Point[], at = 0): number[] {
  const out: number[] = Array.from({ length: at }, () => 0)
  out.push(points.length, W, H)
  for (const [x, y, width = 1, r = 1] of points) out.push(x / W, y / H, width, r, 0, 0)
  return out
}

function packed(points: Point[]) {
  const lines = new LineLayer()
  const p = lines.pack(buffer(points), 0)
  const at = (i: number) => ({
    x: p.points[i * 8]! * W,
    y: p.points[i * 8 + 1]! * H,
    end: p.points[i * 8 + 3]!,
    r: p.points[i * 8 + 4]!,
  })
  const count = Array.from({ length: MAX_LINE_POINTS }).findIndex((_, i) => at(i).end === 1) + 1
  const stretchesIn = (x: number, y: number) => {
    const t = Math.floor(y / 10) * TILES_X + Math.floor(x / 10)
    const first = p.tiles[t * 4]!
    const n = p.tiles[t * 4 + 1]!
    return Array.from({ length: n }, (_, k) => p.tiles[TILES_X * TILES_Y * 4 + first + k]!)
  }
  return { at, count, stretchesIn }
}

describe('LineLayer.pack', () => {
  it('puts nothing between points on a straight line', () => {
    const line = packed([
      [100, 100],
      [140, 100],
      [180, 100],
      [220, 100],
    ])
    expect(line.count).toBe(4)
  })

  it('rounds a bend off with points on a curve through the neighbours', () => {
    // A circle of radius 150 px in 24 steps: as stretches, 1.3 px off at
    // their middles. Its open ends have no neighbour to follow.
    const circle: Point[] = Array.from({ length: 25 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2
      return [320 + 150 * Math.cos(a), 180 + 150 * Math.sin(a)]
    })
    const line = packed(circle)
    expect(line.count).toBeGreaterThan(25)
    for (let i = 0; i < line.count; i++) {
      const { x, y } = line.at(i)
      if (Math.hypot(x - 470, y - 180) < 80) continue
      expect(Math.abs(Math.hypot(x - 320, y - 180) - 150)).toBeLessThan(0.25)
    }
  })

  it('blends the colour along the points put in between', () => {
    const line = packed([
      [100, 100, 1, 0],
      [200, 160, 1, 1],
      [300, 100, 1, 1],
    ])
    const between = Array.from({ length: line.count }, (_, i) => line.at(i)).filter(
      (p) => p.x > 100 && p.x < 200,
    )
    expect(between.length).toBeGreaterThan(0)
    for (const p of between) {
      expect(p.r).toBeGreaterThan(0)
      expect(p.r).toBeLessThan(1)
    }
  })

  it('breaks the line where a width is below zero', () => {
    const line = packed([
      [100, 105],
      [150, 105, -1],
      [300, 105],
      [350, 105],
    ])
    expect(line.at(1).end).toBe(1)
    // Nothing crosses the gap between the two lines.
    expect(line.stretchesIn(225, 105)).toEqual([])
    expect(line.stretchesIn(125, 105)).toEqual([0])
    expect(line.stretchesIn(325, 105)).toEqual([2])
  })

  it('lists a stretch in the tiles it crosses, newest first', () => {
    const line = packed([
      [100, 105],
      [200, 105],
      [100, 105],
    ])
    expect(line.stretchesIn(150, 105)).toEqual([1, 0])
    expect(line.stretchesIn(150, 155)).toEqual([])
  })

  it('keeps the newest stretches where a tile overflows', () => {
    const back: Point[] = Array.from({ length: TILE_ENTRIES + 50 }, (_, i) => [
      i % 2 ? 108 : 102,
      105,
    ])
    const line = packed(back)
    const kept = line.stretchesIn(105, 105)
    expect(kept).toHaveLength(TILE_ENTRIES)
    expect(kept[0]).toBe(back.length - 2)
  })

  it('reads the points from where the preset put them', () => {
    const lines = new LineLayer()
    const p = lines.pack(
      buffer(
        [
          [64, 36],
          [128, 72],
        ],
        500,
      ),
      500,
    )
    expect(p.points[0]).toBeCloseTo(0.1)
    expect(p.points[9]).toBeCloseTo(0.2)
  })
})
