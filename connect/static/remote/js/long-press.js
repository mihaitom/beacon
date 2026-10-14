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

export function onLongPress(element, callback) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function trigger(fingerDown) {
    cancel();
    fired = true;
    if (fingerDown) swallowTrailingClick();
    callback();
  }

  element.addEventListener('pointerdown', (event) => {
    cancel();
    fired = false;
    // A mouse has its right button for this.
    if (event.pointerType === 'mouse') return;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => trigger(true), LONG_PRESS_MS);
  });
  element.addEventListener('pointermove', (event) => {
    if (timer === null) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (dx * dx + dy * dy > SLOP_PX * SLOP_PX) cancel();
  });
  // pointercancel is the browser taking the touch over to scroll.
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    element.addEventListener(type, cancel);
  }
  // Android fires contextmenu on a long press as well, racing the timer -
  // whichever is first opens, the other finds it done. A pending timer
  // means a finger is down; without one it is a mouse, whose right click
  // makes no click to swallow.
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!fired) trigger(timer !== null);
  });
}
