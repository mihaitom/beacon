/**
 * How far right the text inside `root` reaches, in px from `from`'s left
 * edge. Measured from the text itself rather than from `root`'s box, which
 * for a column of block elements is the full width however short the text
 * in it. 0 when there is no text, or no layout to measure (jsdom).
 */
export function textEnd(root: Element, from: Element): number {
  const range = document.createRange()
  if (typeof range.getBoundingClientRect !== 'function') return 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let right = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue
    range.selectNodeContents(node)
    right = Math.max(right, range.getBoundingClientRect().right)
  }
  return right ? right - from.getBoundingClientRect().left : 0
}
