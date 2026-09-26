/**
 * Whether the primary pointer is a finger: phones, and tablets too - an iPad
 * in landscape is wide enough to get the desktop layout. A touch laptop
 * reports a fine pointer and keeps the mouse-shaped controls.
 */
export function isCoarsePointer(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    // No matchMedia (older browser, a test environment): assume a mouse,
    // which is what every control was built for first.
    return false
  }
}
