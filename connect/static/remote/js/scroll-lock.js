// scroll-lock.js — keeps the page behind an open sheet still. iOS hands a
// swipe on the backdrop on to whatever scrolls underneath, and so does a
// swipe on the sheet's own list once that list cannot move any further
// (at its top, at its bottom, or when it is too short to scroll at all) -
// the whole page then rubber-bands along with it. overflow alone stops
// neither, and older iOS ignores overscroll-behavior.

let locks = 0;
let startX = 0;
let startY = 0;

function onTouchStart(event) {
  const touch = event.touches[0];
  if (!touch) return;
  startX = touch.clientX;
  startY = touch.clientY;
}

/** Whether `scroller` can still move the way the finger is going. */
function canScroll(scroller, deltaY) {
  if (scroller.scrollHeight <= scroller.clientHeight) return false;
  // Finger moving down scrolls towards the top, and the other way round.
  if (deltaY > 0) return scroller.scrollTop > 0;
  return scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
}

function onTouchMove(event) {
  const touch = event.touches[0];
  const scroller = event.target.closest?.('[data-scrolls]');
  if (scroller && touch) {
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    // Sideways is a volume row being dragged, never a scroll.
    if (Math.abs(deltaX) > Math.abs(deltaY)) return;
    if (canScroll(scroller, deltaY)) return;
  }
  if (event.cancelable) event.preventDefault();
}

/** Locks the page until the returned function is called. Sheets can stack;
 * the lock lifts with the last one. */
export function lockScroll() {
  if (locks++ === 0) {
    document.documentElement.classList.add('scroll-locked');
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  }
  let released = false;
  return function unlock() {
    if (released) return;
    released = true;
    if (--locks === 0) {
      document.documentElement.classList.remove('scroll-locked');
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
    }
  };
}
