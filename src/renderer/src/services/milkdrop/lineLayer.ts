import type { MilkdropVisualizer } from 'butterchurn'

/** Lines a preset of Beacon's own draws in its shader instead of with
 * Milkdrop's waves, which stop at 4 x 512 points and draw them a pixel
 * wide without smoothing. The preset works out its points and hands them
 * over at the end of its frame equations (`globalThis.beaconLines`, called
 * with Butterchurn's shared memory and where in it they start); this packs
 * them into two textures before Butterchurn draws the frame:
 *
 * - `sampler_lines`: two texels a point - (u, v, width, end) and
 *   (r, g, b, 0) - LINES_WIDTH to a row. `end` 1 leaves out the stretch to
 *   the next point, so one list holds several lines. Where a bend between
 *   two points would show as a corner on screen, points along a curve
 *   through their neighbours are put in between.
 * - `sampler_linetiles`: the screen in TILES_X x TILES_Y tiles. A texel
 *   each first, (first entry, entries), then the entries - the numbers of
 *   the stretches crossing a tile, four to a texel - so a pixel looks only
 *   at the stretches near it. That is what makes thousands of stretches
 *   affordable to draw pixel by pixel.
 *
 * The preset's shader works out the same layout from these constants. */

export const LINES_SAMPLER = 'lines'
export const LINE_TILES_SAMPLER = 'linetiles'
export const LINES_WIDTH = 1024
export const MAX_LINE_POINTS = 16384
export const TILES_X = 64
export const TILES_Y = 36
// A tile in the thick of a figure holds this many stretches at most, the
// newest first: past it, the oldest - the faintest - go.
export const TILE_ENTRIES = 192

const TILES = TILES_X * TILES_Y
const POINT_ROWS = (MAX_LINE_POINTS * 2) / LINES_WIDTH
const MAX_ENTRY_TEXELS = Math.ceil((TILES * TILE_ENTRIES) / 4)
const TILE_ROWS = Math.ceil((TILES + MAX_ENTRY_TEXELS) / LINES_WIDTH)

/** In the preset's buffer: the number of points, the picture's width and
 * height in pixels, then each point as u, v (0-1, v upwards), width in
 * pixels (below zero: no stretch to the next point), r, g, b. */
const HEADER = 3
const POINT_FLOATS = 6
// How far, in pixels, a stretch may stray from the curve before it gets
// points put in between, and how many at most.
const BEND_TOLERANCE = 0.25
const MAX_SPLITS = 8

export type LineDrawer = (buffer: ArrayLike<number>, at: number) => void

/** Hands the preset on screen something to give its lines to; null for
 * none, which leaves a preset that draws lines without them. */
export function showLines(draw: LineDrawer | null): void {
  ;(globalThis as { beaconLines?: LineDrawer | null }).beaconLines = draw
}

export interface PackedLines {
  points: Float32Array
  tiles: Float32Array
  /** How many rows of each texture hold something this frame. */
  pointRows: number
  tileRows: number
}

export class LineLayer {
  private packed: PackedLines = {
    points: new Float32Array(LINES_WIDTH * POINT_ROWS * 4),
    tiles: new Float32Array(LINES_WIDTH * TILE_ROWS * 4),
    pointRows: 0,
    tileRows: 0,
  }
  private counts = new Int32Array(TILES)
  private fill = new Int32Array(TILES)
  // Textures this layer gave their full size; any other - none yet, one of
  // a lost context, Butterchurn's stand-in - is allocated afresh.
  private allocated = new WeakSet<WebGLTexture>()

  /** The textures for the points in `buffer` from `at` on. */
  pack(buffer: ArrayLike<number>, at: number): PackedLines {
    const given = Math.max(0, Math.min(MAX_LINE_POINTS, Math.floor(buffer[at] ?? 0)))
    const width = buffer[at + 1] || 1
    const height = buffer[at + 2] || 1
    const { points, tiles } = this.packed
    const base = at + HEADER
    const ends = (i: number) => i >= given - 1 || (buffer[base + i * POINT_FLOATS + 2] ?? 0) < 0
    let count = 0
    for (let i = 0; i < given && count < MAX_LINE_POINTS; i++) {
      const a = base + i * POINT_FLOATS
      const end = ends(i)
      let to = count * 8
      points[to] = buffer[a] ?? 0
      points[to + 1] = buffer[a + 1] ?? 0
      points[to + 2] = Math.abs(buffer[a + 2] ?? 0)
      points[to + 3] = end ? 1 : 0
      points[to + 4] = buffer[a + 3] ?? 0
      points[to + 5] = buffer[a + 4] ?? 0
      points[to + 6] = buffer[a + 5] ?? 0
      points[to + 7] = 0
      count++
      if (end) continue
      // Catmull-Rom through the neighbours; at a line's end, the neighbour
      // on the other side mirrored, which keeps a straight end straight.
      // Halfway, the curve lies (p1 + p2 - p0 - p3) / 16 off the stretch -
      // what of that is across it shows - and splitting into n takes that
      // down n * n times.
      const b = a + POINT_FLOATS
      const x1 = buffer[a] ?? 0
      const y1 = buffer[a + 1] ?? 0
      const x2 = buffer[b] ?? 0
      const y2 = buffer[b + 1] ?? 0
      const first = i === 0 || ends(i - 1)
      const last = ends(i + 1)
      const x0 = first ? 2 * x1 - x2 : (buffer[a - POINT_FLOATS] ?? 0)
      const y0 = first ? 2 * y1 - y2 : (buffer[a - POINT_FLOATS + 1] ?? 0)
      const x3 = last ? 2 * x2 - x1 : (buffer[b + POINT_FLOATS] ?? 0)
      const y3 = last ? 2 * y2 - y1 : (buffer[b + POINT_FLOATS + 1] ?? 0)
      const dx = (x2 - x1) * width
      const dy = (y2 - y1) * height
      const ox = (x1 + x2 - x0 - x3) * width
      const oy = (y1 + y2 - y0 - y3) * height
      const off = Math.abs(ox * dy - oy * dx) / (16 * Math.max(Math.hypot(dx, dy), 1e-6))
      if (off <= BEND_TOLERANCE) continue
      const splits = Math.min(MAX_SPLITS, Math.ceil(Math.sqrt(off / BEND_TOLERANCE)))
      const from = to
      for (let n = 1; n < splits && count < MAX_LINE_POINTS; n++) {
        const t = n / splits
        const t2 = t * t
        const t3 = t2 * t
        // The curve's weights on p0 to p3.
        const k0 = 0.5 * (-t + 2 * t2 - t3)
        const k1 = 0.5 * (2 - 5 * t2 + 3 * t3)
        const k2 = 0.5 * (t + 4 * t2 - 3 * t3)
        const k3 = 0.5 * (t3 - t2)
        to = count * 8
        points[to] = k0 * x0 + k1 * x1 + k2 * x2 + k3 * x3
        points[to + 1] = k0 * y0 + k1 * y1 + k2 * y2 + k3 * y3
        points[to + 2] = points[from + 2]! + (Math.abs(buffer[b + 2] ?? 0) - points[from + 2]!) * t
        points[to + 3] = 0
        for (let k = 0; k < 3; k++) {
          points[to + 4 + k] =
            points[from + 4 + k]! + ((buffer[b + 3 + k] ?? 0) - points[from + 4 + k]!) * t
        }
        points[to + 7] = 0
        count++
      }
    }
    if (count > 0) points[(count - 1) * 8 + 3] = 1

    // Each stretch into every tile its line could colour, newest first.
    const counts = this.counts
    counts.fill(0)
    const tileW = width / TILES_X
    const tileH = height / TILES_Y
    const visit = (i: number, tile: (index: number) => void) => {
      const a = i * 8
      const b = a + 8
      const reach = Math.max(points[a + 2]!, points[b + 2]!) / 2 + 1
      const x0 = Math.min(points[a]!, points[b]!) * width - reach
      const x1 = Math.max(points[a]!, points[b]!) * width + reach
      const y0 = Math.min(points[a + 1]!, points[b + 1]!) * height - reach
      const y1 = Math.max(points[a + 1]!, points[b + 1]!) * height + reach
      const tx0 = Math.max(0, Math.floor(x0 / tileW))
      const tx1 = Math.min(TILES_X - 1, Math.floor(x1 / tileW))
      const ty0 = Math.max(0, Math.floor(y0 / tileH))
      const ty1 = Math.min(TILES_Y - 1, Math.floor(y1 / tileH))
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) tile(ty * TILES_X + tx)
      }
    }
    const drawn = (i: number) => points[i * 8 + 3] === 0
    for (let i = count - 2; i >= 0; i--) {
      if (drawn(i)) visit(i, (t) => counts[t]!++)
    }
    // Header texels, then each tile's run of entries.
    let next = 0
    for (let t = 0; t < TILES; t++) {
      const n = Math.min(TILE_ENTRIES, counts[t]!)
      tiles[t * 4] = next
      tiles[t * 4 + 1] = n
      tiles[t * 4 + 2] = 0
      tiles[t * 4 + 3] = 0
      this.fill[t] = next
      next += n
    }
    const entries = TILES * 4
    for (let i = count - 2; i >= 0; i--) {
      if (!drawn(i)) continue
      visit(i, (t) => {
        const slot = this.fill[t]!
        if (slot - tiles[t * 4]! < tiles[t * 4 + 1]!) {
          tiles[entries + slot] = i
          this.fill[t] = slot + 1
        }
      })
    }
    this.packed.pointRows = Math.max(1, Math.ceil((count * 2) / LINES_WIDTH))
    this.packed.tileRows = Math.max(1, Math.ceil((TILES + Math.ceil(next / 4)) / LINES_WIDTH))
    return this.packed
  }

  /** Packs and uploads them to the visualizer's `sampler_lines` and
   * `sampler_linetiles`. False when this Butterchurn has no room. */
  upload(visualizer: MilkdropVisualizer, buffer: ArrayLike<number>, at: number): boolean {
    const packed = this.pack(buffer, at)
    return (
      this.put(visualizer, LINES_SAMPLER, packed.points, POINT_ROWS, packed.pointRows) &&
      this.put(visualizer, LINE_TILES_SAMPLER, packed.tiles, TILE_ROWS, packed.tileRows)
    )
  }

  /** Into the texture, allocated once at its full size, only the rows in
   * use: most frames fill a fraction of it. */
  private put(
    visualizer: MilkdropVisualizer,
    name: string,
    data: Float32Array,
    rows: number,
    used: number,
  ): boolean {
    const renderer = (visualizer as unknown as RendererInternals).renderer
    const gl = renderer?.gl
    const samplers = renderer?.image?.samplers
    if (!gl || !samplers) return false
    let texture = samplers[name]
    if (!texture || !this.allocated.has(texture) || !gl.isTexture(texture)) {
      texture = gl.createTexture() ?? undefined
      if (!texture) return false
      samplers[name] = texture
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, LINES_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, data)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.allocated.add(texture)
      return true
    }
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      LINES_WIDTH,
      Math.min(rows, used),
      gl.RGBA,
      gl.FLOAT,
      data,
    )
    return true
  }
}

/** The parts of Butterchurn's renderer this reaches into, as textures.ts
 * does (Butterchurn pinned to 2.6.7). */
interface RendererInternals {
  renderer?: {
    gl?: WebGL2RenderingContext
    image?: { samplers: Record<string, WebGLTexture | undefined> }
  }
}
