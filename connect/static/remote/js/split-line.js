// split-line.js — a row's or card's second line with what the library is
// sorted by at its far end (the app's .mobile-split-line): the line's own
// text clips, the value keeps its width.

export function fillSplitLine(element, text, detail) {
  element.textContent = '';
  if (!detail) {
    element.textContent = text;
    return;
  }
  element.classList.add('split-line');
  const main = document.createElement('span');
  main.textContent = text;
  const value = document.createElement('span');
  value.textContent = detail;
  element.append(main, value);
}
