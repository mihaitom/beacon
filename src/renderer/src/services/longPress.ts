// Held this long without moving, a touch is a long press. Android's own
// long-press timeout is about the same, so the two arrive close together.
export const LONG_PRESS_MS = 500
// A finger wobbles; further than this and it is scrolling or dragging.
export const LONG_PRESS_SLOP_PX = 10
// How long after the finger lifts the click it synthesises can still be on
// its way - touch delivers it a task or two later, not with the pointerup.
const TRAILING_CLICK_MS = 500

/** Long press on a touch screen, and a right click wherever there is a
 * mouse - both open the same thing. Feed it the element's pointer events.
 *
 * The click the browser makes out of the released finger is swallowed: it
 * would otherwise play the row, or land on the sheet that just opened under
 * the finger and close it again. */
export class LongPress {
  private timer: ReturnType<typeof setTimeout> | null = null
  private startX = 0
  private startY = 0
  private fired = false
  private clickGuardTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onLongPress: () => void) {}

  down(event: PointerEvent): void {
    this.cancel()
    this.fired = false
    // A mouse has its right button for this, and holding the left one
    // still is how a click starts.
    if (event.pointerType === 'mouse') return
    this.startX = event.clientX
    this.startY = event.clientY
    this.timer = setTimeout(() => this.trigger(true), LONG_PRESS_MS)
  }

  move(event: PointerEvent): void {
    if (this.timer === null) return
    const dx = event.clientX - this.startX
    const dy = event.clientY - this.startY
    if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX ** 2) this.cancel()
  }

  /** pointerup, pointercancel (the browser took the touch over to scroll)
   * and pointerleave alike. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Unmount: drops a pending press and a click guard still armed. */
  dispose(): void {
    this.cancel()
    this.disarmClickGuard()
  }

  /** Android fires contextmenu on a long press as well, racing the timer -
   * whichever is first opens, the other finds it done. */
  contextMenu(event: Event): void {
    event.preventDefault()
    // A pending timer means a finger is down; otherwise it is a mouse,
    // whose right click makes no click to swallow.
    if (!this.fired) this.trigger(this.timer !== null)
  }

  private trigger(fingerDown: boolean): void {
    this.cancel()
    this.fired = true
    if (fingerDown) this.armClickGuard()
    this.onLongPress()
  }

  // On window, in the capture phase: ahead of the row's own handler and of
  // a sheet's click-outside alike. The guard expires with the first click,
  // or shortly after the finger lifts when none comes (Android after its
  // own contextmenu).
  private armClickGuard(): void {
    this.disarmClickGuard()
    window.addEventListener('click', this.swallowClick, true)
    window.addEventListener('pointerup', this.expireClickGuard, true)
    window.addEventListener('pointercancel', this.expireClickGuard, true)
  }

  private swallowClick = (event: Event): void => {
    event.stopPropagation()
    event.preventDefault()
    this.disarmClickGuard()
  }

  private expireClickGuard = (): void => {
    window.removeEventListener('pointerup', this.expireClickGuard, true)
    window.removeEventListener('pointercancel', this.expireClickGuard, true)
    if (this.clickGuardTimer !== null) clearTimeout(this.clickGuardTimer)
    this.clickGuardTimer = setTimeout(this.disarmClickGuard, TRAILING_CLICK_MS)
  }

  private disarmClickGuard = (): void => {
    window.removeEventListener('click', this.swallowClick, true)
    window.removeEventListener('pointerup', this.expireClickGuard, true)
    window.removeEventListener('pointercancel', this.expireClickGuard, true)
    if (this.clickGuardTimer !== null) clearTimeout(this.clickGuardTimer)
    this.clickGuardTimer = null
  }
}
