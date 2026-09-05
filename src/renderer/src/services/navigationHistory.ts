import { reactive } from 'vue'
import router from '@/router'

/**
 * Back/forward navigation for the desktop shell.
 *
 * The window has no browser chrome around it, so nothing offered a way out
 * of a detail page: opening an album from an artist page left the artist
 * page reachable only by searching for it again. The router has kept a
 * full history all along - this only exposes it.
 *
 * Vue Router writes `back`/`forward` into the history state itself (it
 * needs them for its own scroll restoration), so whether there is anywhere
 * to go is a question the history can already answer. No parallel stack of
 * our own to keep in sync, which is the part that would drift the moment
 * someone used a real browser's own back button in the web build.
 */
export const navigationHistory = reactive({
  canGoBack: false,
  canGoForward: false,
})

function syncFromHistory(): void {
  // Null at the very first entry, and briefly before the router has
  // written its initial state at boot.
  const state = (router.options.history.state ?? {}) as {
    back?: unknown
    forward?: unknown
  }
  navigationHistory.canGoBack = state.back != null
  navigationHistory.canGoForward = state.forward != null
}

export function goBack(): void {
  if (navigationHistory.canGoBack) router.back()
}

export function goForward(): void {
  if (navigationHistory.canGoForward) router.forward()
}

/** Buttons 3 and 4 are the mouse's own back/forward, which plenty of mice
 * have and which nothing in a frameless Electron window answers. Chromium
 * acts on the *release*; taking the press away from it is what keeps a
 * browser (the web build) from navigating a second time on top of ours. */
function onMouseDown(event: MouseEvent): void {
  if (event.button === 3 || event.button === 4) event.preventDefault()
}

function onMouseUp(event: MouseEvent): void {
  if (event.button === 3) {
    event.preventDefault()
    goBack()
  } else if (event.button === 4) {
    event.preventDefault()
    goForward()
  }
}

/** Called once from App.vue. Listeners live as long as the window does,
 * so there is nothing to tear down - same arrangement as
 * services/keyboardShortcuts.ts. */
export function initNavigationHistory(): void {
  router.afterEach(syncFromHistory)
  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  syncFromHistory()
}
