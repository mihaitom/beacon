// range.js — paints the "filled" portion of an <input type="range"> as a
// background gradient on the element itself. Firefox already does this
// natively (::-moz-range-progress, styled in app.css), but WebKit (Safari/
// Chrome — what this PWA actually runs under on iOS/Android in practice)
// has no equivalent pseudo-element for it at all, so without this every
// slider here would just show flat, unfilled track regardless of value —
// exactly what a plain, un-themed native <input type="range"> looks like.
//
// Call after any programmatic value/min/max change (state sync in a view's
// render()) *and* wire it to the element's own 'input' event so dragging
// updates the fill live rather than only on the next state tick.
export function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const percent = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  input.style.background = `linear-gradient(to right, var(--accent) ${percent}%, var(--surface-2) ${percent}%)`;
}
