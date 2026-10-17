// long-press.js — long press on a touch screen, right click with a mouse,
// both calling the same thing. The web app's services/longPress.ts.

// Held this long without moving, a touch is a long press. Android's own
// long-press timeout is about the same, so the two arrive close together.
const LONG_PRESS_MS = 500;
// A finger wobbles; further than this and it is scrolling or dragging.
const SLOP_PX = 10;
// How long after the finger lifts the click it synthesises can still be on
// its way - touch delivers it a task or two later, not with the pointerup.
const TRAILING_CLICK_MS = 500;

/** The click the browser makes out of the released finger is swallowed: it
 * would otherwise play the row, or land on the sheet that just opened under
 * the finger and close it again. On window, in the capture phase, ahead of
 * both; it expires with the first click, or shortly after the finger lifts
 * when none comes (Android after its own contextmenu). */
function swallowTrailingClick() {
  let timer = null;
  function disarm() {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerup', expire, true);
    window.removeEventListener('pointercancel', expire, true);
    clearTimeout(timer);
  }
  function swallow(event) {
    event.stopPropagation();
    event.preventDefault();
    disarm();
  }
  function expire() {
    window.removeEventListener('pointerup', expire, true);
    window.removeEventListener('pointercancel', expire, true);
    timer = setTimeout(disarm, TRAILING_CLICK_MS);
  }
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerup', expire, true);
  window.addEventListener('pointercancel', expire, true);
}

/** `pickUp` ({ enabled, onLift, onDrag }), for a row that can be dragged:
 * a held touch lifts it instead of opening at once - moved from there it
 * drags, let go without moving it opens after all. A mouse drags as soon as
 * it moves with the button down. The web app's PickUp. */
export function onLongPress(element, callback, pickUp = null) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;
  // idle, pending (finger down, not held long enough), mouse (left button
  // down), lifted, dragging.
  let phase = 'idle';
  let pickUpNow = false;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function cancel() {
    clearTimer();
    if (phase === 'lifted') pickUp.onLift(false);
    if (phase !== 'dragging') phase = 'idle';
  }

  function trigger(fingerDown) {
    cancel();
    fired = true;
    if (fingerDown) swallowTrailingClick();
    callback();
  }

  function lift() {
    clearTimer();
    phase = 'lifted';
    swallowTrailingClick();
    // Android only; iOS gives a web page no way to tap.
    navigator.vibrate?.(10);
    pickUp.onLift(true);
  }

  // A drag ends with the touch, wherever its pointerup went - see the
  // scroll block below for why the element may be detached by then.
  function endDrag() {
    for (const target of [window, element]) {
      target.removeEventListener('touchend', endDrag, true);
      target.removeEventListener('touchcancel', endDrag, true);
    }
    if (phase === 'dragging') phase = 'idle';
  }

  element.addEventListener('pointerdown', (event) => {
    cancel();
    fired = false;
    pickUpNow = Boolean(pickUp) && (pickUp.enabled?.() ?? true);
    startX = event.clientX;
    startY = event.clientY;
    // A mouse has its right button for this.
    if (event.pointerType === 'mouse') {
      if (pickUpNow && event.button === 0) phase = 'mouse';
      return;
    }
    phase = 'pending';
    if (pickUpNow) {
      for (const target of [window, element]) {
        target.addEventListener('touchend', endDrag, true);
        target.addEventListener('touchcancel', endDrag, true);
      }
    }
    timer = setTimeout(() => (pickUpNow ? lift() : trigger(true)), LONG_PRESS_MS);
  });
  element.addEventListener('pointermove', (event) => {
    if (phase !== 'pending' && phase !== 'lifted' && phase !== 'mouse') return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (dx * dx + dy * dy <= SLOP_PX * SLOP_PX) return;
    if (phase === 'pending') {
      cancel();
      return;
    }
    if (phase === 'lifted') pickUp.onLift(false);
    phase = 'dragging';
    pickUp.onDrag(event);
  });
  element.addEventListener('pointerup', () => {
    if (phase === 'lifted') {
      phase = 'idle';
      pickUp.onLift(false);
      fired = true;
      callback();
      return;
    }
    cancel();
    phase = 'idle';
  });
  // pointercancel is the browser taking the touch over to scroll.
  for (const type of ['pointercancel', 'pointerleave']) {
    element.addEventListener(type, cancel);
  }
  // Keeps the page from scrolling under a lifted or dragged row - only a
  // non-passive touchmove can. Bound for the element's whole life: the
  // browser looks for one as the finger comes down, and the queue rebuilds
  // its rows mid-drag, after which the touch goes to the detached one alone.
  if (pickUp) {
    element.addEventListener(
      'touchmove',
      (event) => {
        if (phase === 'lifted' || phase === 'dragging') event.preventDefault();
      },
      { passive: false },
    );
  }
  // Android fires contextmenu on a long press as well, racing the timer -
  // whichever is first opens (or lifts), the other finds it done. A pending
  // timer means a finger is down; without one it is a mouse, whose right
  // click makes no click to swallow.
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (fired) return;
    if (timer === null) {
      if (phase !== 'lifted' && phase !== 'dragging') trigger(false);
      return;
    }
    if (pickUpNow) lift();
    else trigger(true);
  });
}
