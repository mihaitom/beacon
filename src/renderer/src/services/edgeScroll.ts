// Dragging within this far of a list's top or bottom edge scrolls it,
// faster the closer to the edge, up to EDGE_SCROLL_MAX_PX_PER_S right at
// it. The browser's own drag scrolling crawls through a long queue, and a
// touch drag gets none at all.
export const EDGE_SCROLL_ZONE_PX = 64
export const EDGE_SCROLL_MAX_PX_PER_S = 1400

/** Pixels to scroll for a pointer at `y` over `dtSeconds`, given the
 * visible band [top, bottom]: negative scrolls up, 0 outside both zones. */
export function edgeScrollDelta(y: number, top: number, bottom: number, dtSeconds: number): number {
  const intoTop = top + EDGE_SCROLL_ZONE_PX - y
  const intoBottom = y - (bottom - EDGE_SCROLL_ZONE_PX)
  const depth = Math.max(intoTop, intoBottom)
  if (depth <= 0) return 0
  // Squared, so the edge of the zone creeps and the very edge races.
  const share = Math.min(depth / EDGE_SCROLL_ZONE_PX, 1) ** 2
  const step = share * EDGE_SCROLL_MAX_PX_PER_S * dtSeconds
  return intoTop > 0 ? -step : step
}

/** The part of the container its content is actually visible in. Its own
 * padding is left out: the phone shell's pane is padded by the app bar and
 * the tab bar lying over it, so its box reaches behind both. */
function visibleBand(container: HTMLElement): { top: number; bottom: number } {
  const rect = container.getBoundingClientRect()
  const style = getComputedStyle(container)
  return {
    top: rect.top + (parseFloat(style.paddingTop) || 0),
    bottom: rect.bottom - (parseFloat(style.paddingBottom) || 0),
  }
}

export interface EdgeScrollerOptions {
  container: () => HTMLElement | null
  /** How long a reported position stays valid. HTML5 drag-and-drop keeps
   * reporting while the pointer is over the list and goes quiet once it
   * leaves; a pointer drag only reports when the finger moves, so a finger
   * held still at the edge has to keep scrolling - omit it there. */
  staleMs?: number
  /** After every frame that scrolled - the row under a pointer that held
   * still has changed all the same. */
  onScroll?: () => void
}

/** The frame loop behind a drag's edge scrolling: start() on drag start,
 * update() with every pointer position, stop() when it ends. */
export class EdgeScroller {
  private y = 0
  private seenAt = 0
  private lastTick = 0
  private frame = 0

  constructor(private readonly options: EdgeScrollerOptions) {}

  start(): void {
    this.stop()
    this.seenAt = 0
    this.lastTick = performance.now()
    this.frame = requestAnimationFrame(this.tick)
  }

  update(y: number): void {
    this.y = y
    this.seenAt = performance.now()
  }

  stop(): void {
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private tick = (now: number): void => {
    const dt = Math.min(now - this.lastTick, 50) / 1000
    this.lastTick = now
    const container = this.options.container()
    const { staleMs } = this.options
    const fresh = this.seenAt > 0 && (staleMs === undefined || now - this.seenAt < staleMs)
    if (container && fresh) {
      const { top, bottom } = visibleBand(container)
      const delta = edgeScrollDelta(this.y, top, bottom, dt)
      if (delta !== 0) {
        const before = container.scrollTop
        container.scrollTop += delta
        if (container.scrollTop !== before) this.options.onScroll?.()
      }
    }
    this.frame = requestAnimationFrame(this.tick)
  }
}

/** The nearest ancestor that scrolls vertically - for a list that rides
 * whatever pane it was placed in rather than scrolling itself. */
export function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}
