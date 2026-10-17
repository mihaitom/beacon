// Held this long without moving, a touch is a long press. Android's own
// long-press timeout is about the same, so the two arrive close together.
export const LONG_PRESS_MS = 500
// A finger wobbles; further than this and it is scrolling or dragging.
export const LONG_PRESS_SLOP_PX = 10
// How long after the finger lifts the click it synthesises can still be on
// its way - touch delivers it a task or two later, not with the pointerup.
const TRAILING_CLICK_MS = 500

/** What a press can also pick up, for a row that can be dragged. */
export interface PickUp {
  /** Checked as the press starts; false leaves it a plain long press. */
  enabled?: () => boolean
  /** The row is held up (true) or put back down (false). */
  onLift: (lifted: boolean) => void
  /** Moved once lifted: the drag takes over from here, with this move. */
  onDrag: (event: PointerEvent) => void
}

/** Long press on a touch screen, and a right click wherever there is a
 * mouse - both open the same thing. Feed it the element's pointer events.
 *
 * With a `pickUp`, a held touch lifts the row instead of opening at once:
 * moved from there it drags, released without moving it opens after all -
 * the way a touch screen tells the two apart without a handle, since a
 * finger moved straight away is scrolling. A mouse drags as soon as it
 * moves with the button down, like the desktop's queue.
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
  /** pending: a finger is down, not yet held long enough. mouse: the left
   * button is down. lifted, dragging: see PickUp. */
  private phase: 'idle' | 'pending' | 'mouse' | 'lifted' | 'dragging' = 'idle'
  private pickUpNow = false
  private touchElement: EventTarget | null = null

  constructor(
    private readonly onLongPress: () => void,
    private readonly pickUp: PickUp | null = null,
  ) {}

  down(event: PointerEvent): void {
    this.cancel()
    this.fired = false
    this.pickUpNow = !!this.pickUp && (this.pickUp.enabled?.() ?? true)
    this.startX = event.clientX
    this.startY = event.clientY
    // A mouse has its right button for this, and holding the left one
    // still is how a click starts.
    if (event.pointerType === 'mouse') {
      if (this.pickUpNow && event.button === 0) this.phase = 'mouse'
      return
    }
    this.phase = 'pending'
    if (this.pickUpNow) this.watchTouchEnd(event.currentTarget)
    this.timer = setTimeout(
      () => (this.pickUpNow ? this.lift() : this.trigger(true)),
      LONG_PRESS_MS,
    )
  }

  move(event: PointerEvent): void {
    if (this.phase !== 'pending' && this.phase !== 'lifted' && this.phase !== 'mouse') return
    const dx = event.clientX - this.startX
    const dy = event.clientY - this.startY
    if (dx * dx + dy * dy <= LONG_PRESS_SLOP_PX ** 2) return
    if (this.phase === 'pending') {
      this.cancel()
      return
    }
    if (this.phase === 'lifted') this.pickUp!.onLift(false)
    this.phase = 'dragging'
    this.pickUp!.onDrag(event)
  }

  /** pointerup. Opens a row that was lifted and not moved. */
  up(): void {
    if (this.phase === 'lifted') {
      this.phase = 'idle'
      this.pickUp!.onLift(false)
      this.fired = true
      this.onLongPress()
      return
    }
    this.cancel()
    this.phase = 'idle'
  }

  /** pointercancel (the browser took the touch over to scroll) and
   * pointerleave alike. A drag under way is the drag's own business. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.phase === 'lifted') this.pickUp!.onLift(false)
    if (this.phase !== 'dragging') this.phase = 'idle'
  }

  /** Unmount: drops a pending press and a click guard still armed. */
  dispose(): void {
    // A drag under way is left running: unmounted mid-drag is the row
    // scrolled out of view, and the touch still has to end.
    this.cancel()
    this.disarmClickGuard()
  }

  /** Android fires contextmenu on a long press as well, racing the timer -
   * whichever is first opens, the other finds it done. */
  contextMenu(event: Event): void {
    event.preventDefault()
    if (this.fired) return
    // A pending timer means a finger is down; otherwise it is a mouse,
    // whose right click makes no click to swallow.
    if (this.timer === null) {
      if (this.phase !== 'lifted' && this.phase !== 'dragging') this.trigger(false)
      return
    }
    if (this.pickUpNow) this.lift()
    else this.trigger(true)
  }

  private lift(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.phase = 'lifted'
    this.armClickGuard()
    // Android only; iOS gives a web page no way to tap.
    navigator.vibrate?.(10)
    this.pickUp!.onLift(true)
  }

  private trigger(fingerDown: boolean): void {
    this.cancel()
    this.fired = true
    if (fingerDown) this.armClickGuard()
    this.onLongPress()
  }

  /** Keeps the page from scrolling under a lifted or dragged row. Only a
   * touchmove can do that, and only one that is not passive - the rows
   * themselves must stay pannable, or the list could not be scrolled at
   * all.
   *
   * Bound once, for the element's whole life, rather than as a press
   * starts: the browser looks for a blocking touch listener when the finger
   * comes down, and one added then is too late to be asked. Never removed
   * either - the list drops a row scrolled out of view mid-drag, and the
   * touch's events then go to the detached node alone. */
  bindScrollBlock(element: EventTarget): void {
    element.addEventListener('touchmove', this.blockScroll, { passive: false })
  }

  private blockScroll = (event: Event): void => {
    if (this.phase === 'lifted' || this.phase === 'dragging') event.preventDefault()
  }

  /** A drag ends with the touch, wherever its pointerup went. */
  private watchTouchEnd(element: EventTarget | null): void {
    this.releaseTouch()
    this.touchElement = element
    for (const target of [window, element]) {
      target?.addEventListener('touchend', this.releaseTouch, true)
      target?.addEventListener('touchcancel', this.releaseTouch, true)
    }
  }

  private releaseTouch = (): void => {
    for (const target of [window, this.touchElement]) {
      target?.removeEventListener('touchend', this.releaseTouch, true)
      target?.removeEventListener('touchcancel', this.releaseTouch, true)
    }
    this.touchElement = null
    if (this.phase === 'dragging') this.phase = 'idle'
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
