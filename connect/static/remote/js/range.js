// range.js — reports how far an <input type="range"> is filled, as the
// --fill custom property app.css draws the track from. Firefox fills the
// track natively (::-moz-range-progress, styled there), but WebKit (Safari/
// Chrome — what this PWA actually runs under on iOS/Android in practice)
// has no equivalent pseudo-element at all, so without this every slider
// here would show flat, unfilled track regardless of value.
//
// A property rather than a background on the element: the element is 32px
// high so a finger can hit it, while the track it draws is 4px. Painting
// the element itself would fill all 32 of them.
//
// Call after any programmatic value/min/max change (state sync in a view's
// render()) *and* wire it to the element's own 'input' event so dragging
// updates the fill live rather than only on the next state tick.
export function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const percent = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  input.style.setProperty('--fill', `${percent}%`);
}
