import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EDGE_SCROLL_MAX_PX_PER_S,
  EDGE_SCROLL_ZONE_PX,
  EdgeScroller,
  edgeScrollDelta,
  scrollParent,
} from '../edgeScroll'

describe('edgeScrollDelta', () => {
  it('leaves the middle of the list alone', () => {
    expect(edgeScrollDelta(300, 0, 600, 1)).toBe(0)
    expect(edgeScrollDelta(EDGE_SCROLL_ZONE_PX, 0, 600, 1)).toBe(0)
  })

  it('scrolls up near the top and down near the bottom', () => {
    expect(edgeScrollDelta(10, 0, 600, 1)).toBeLessThan(0)
    expect(edgeScrollDelta(590, 0, 600, 1)).toBeGreaterThan(0)
  })

  it('goes faster the closer the pointer is to the edge', () => {
    expect(edgeScrollDelta(560, 0, 600, 1)).toBeLessThan(edgeScrollDelta(590, 0, 600, 1))
  })

  it('tops out at the edge and beyond it', () => {
    expect(edgeScrollDelta(600, 0, 600, 1)).toBe(EDGE_SCROLL_MAX_PX_PER_S)
    expect(edgeScrollDelta(900, 0, 600, 1)).toBe(EDGE_SCROLL_MAX_PX_PER_S)
    expect(edgeScrollDelta(-50, 0, 600, 1)).toBe(-EDGE_SCROLL_MAX_PX_PER_S)
  })
})

describe('EdgeScroller', () => {
  let frames: FrameRequestCallback[]
  let now: number

  /** Runs the next `count` animation frames, 16ms apart. */
  function runFrames(count: number) {
    for (let i = 0; i < count; i++) {
      now += 16
      const pending = frames
      frames = []
      pending.forEach((callback) => callback(now))
    }
  }

  function pane(paddingBottom = 0) {
    const element = document.createElement('div')
    element.style.paddingBottom = `${paddingBottom}px`
    element.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect
    return element
  }

  beforeEach(() => {
    frames = []
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = []
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does nothing until a position is reported', () => {
    const element = pane()
    const scroller = new EdgeScroller({ container: () => element })
    scroller.start()
    runFrames(10)
    expect(element.scrollTop).toBe(0)
  })

  it('keeps scrolling while a finger holds still at the edge', () => {
    const element = pane()
    const onScroll = vi.fn()
    const scroller = new EdgeScroller({ container: () => element, onScroll })
    scroller.start()
    scroller.update(599)
    runFrames(5)
    const afterFive = element.scrollTop
    runFrames(5)

    expect(afterFive).toBeGreaterThan(0)
    expect(element.scrollTop).toBeGreaterThan(afterFive)
    expect(onScroll).toHaveBeenCalled()
  })

  it('stops once reports go stale, when told they do', () => {
    const element = pane()
    const scroller = new EdgeScroller({ container: () => element, staleMs: 200 })
    scroller.start()
    scroller.update(599)
    runFrames(20)
    const settled = element.scrollTop
    runFrames(10)

    expect(settled).toBeGreaterThan(0)
    expect(element.scrollTop).toBe(settled)
  })

  it('stops on stop()', () => {
    const element = pane()
    const scroller = new EdgeScroller({ container: () => element })
    scroller.start()
    scroller.update(599)
    runFrames(2)
    scroller.stop()
    const stopped = element.scrollTop
    runFrames(5)

    expect(element.scrollTop).toBe(stopped)
  })

  /** The phone shell's pane is padded by the tab bar lying over it: its
   * box reaches behind the bar, and the zone has to end where the rows do. */
  it('measures the zone from inside the padding', () => {
    const element = pane(100)
    const scroller = new EdgeScroller({ container: () => element })
    scroller.start()
    scroller.update(490)
    runFrames(3)

    expect(element.scrollTop).toBeGreaterThan(0)
  })
})

describe('scrollParent', () => {
  it('finds the nearest ancestor that scrolls', () => {
    const outer = document.createElement('div')
    outer.style.overflowY = 'auto'
    const middle = document.createElement('div')
    const inner = document.createElement('div')
    outer.append(middle)
    middle.append(inner)

    expect(scrollParent(inner)).toBe(outer)
  })
})
