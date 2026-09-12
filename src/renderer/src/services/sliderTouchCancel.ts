/**
 * Ends a slider drag the browser took away from it.
 *
 * A touch is cancelled rather than ended whenever the browser decides the
 * gesture was a scroll after all, and by a call or a system gesture
 * arriving mid-drag. Vuetify's slider only ever listens for `touchend`
 * (vuetify/lib/components/VSlider/slider.js), so on a cancel its drag never
 * finishes: no `end` is emitted, which leaves the volume guard in a drag
 * that never ends and the slider deaf to the speaker from then on (see
 * connect/volumeGuard.ts), and the window-level `touchmove` listener the
 * drag installed stays installed. Every later finger anywhere on the page
 * then goes on driving that slider - one swipe up the page near its left
 * edge set a speaker to 0. Leaving the screen doesn't clear it either: the
 * slider's own teardown removes that listener without the `capture` flag it
 * was added with, which removes nothing.
 *
 * Handing the slider the `touchend` it is waiting for runs its own
 * teardown instead: the listener goes and `end` is emitted with the
 * position the finger was taken away at.
 *
 * A MouseEvent, not a TouchEvent, because Safari has no TouchEvent
 * constructor. The slider reads the position off `touches`/`changedTouches`
 * where either is present and off `clientX` otherwise, so a mouse-shaped
 * event named `touchend` arrives at the same value.
 */
export function endCancelledSliderTouch(event: TouchEvent): void {
  const touch = event.changedTouches[0]
  if (!event.target || !touch) return
  event.target.dispatchEvent(
    new MouseEvent('touchend', {
      bubbles: true,
      cancelable: true,
      clientX: touch.clientX,
      clientY: touch.clientY,
    }),
  )
}
