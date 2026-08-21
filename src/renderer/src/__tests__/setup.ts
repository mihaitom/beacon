// Global jsdom polyfills for component tests that mount real Vuetify
// components (see vitest.config.ts's `setupFiles`). jsdom implements
// neither of these — Vuetify's layout/display composables (VFooter's
// resize tracking, useDisplay's breakpoint matching) call them
// unconditionally on mount, so without a stub every such test blows up
// before it renders anything, regardless of what it's actually testing.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// Only needed once a test actually opens a v-menu/v-tooltip/etc. for
// real (not stubbed) — Vuetify's VOverlay reads this to position itself
// against the viewport, and jsdom has no implementation of it at all.
if (!window.visualViewport) {
  window.visualViewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as unknown as VisualViewport
}
