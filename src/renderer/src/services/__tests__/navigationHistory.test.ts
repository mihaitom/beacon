import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in for the real router: importing that one would pull in every
// route's guard (and the auth store behind them) just to read two fields
// off a history object. `state` is deliberately the same object throughout
// so a test can change what the history says without re-mocking.
// vi.hoisted, because vi.mock's factory is lifted above every import and
// would otherwise reach these before they exist.
const { historyState, afterEachCallbacks } = vi.hoisted(() => ({
  historyState: { back: null, forward: null } as { back: unknown; forward: unknown },
  afterEachCallbacks: [] as (() => void)[],
}))

vi.mock('@/router', () => ({
  default: {
    options: { history: { state: historyState } },
    afterEach: (callback: () => void) => afterEachCallbacks.push(callback),
    back: vi.fn(),
    forward: vi.fn(),
  },
}))

import router from '@/router'
import { goBack, goForward, initNavigationHistory, navigationHistory } from '../navigationHistory'

/** What the router reports after a navigation. The module only ever reads
 * these on the afterEach hook, so the test has to run it too. */
function navigatedTo(state: { back?: unknown; forward?: unknown }): void {
  historyState.back = state.back ?? null
  historyState.forward = state.forward ?? null
  for (const callback of afterEachCallbacks) callback()
}

function mouse(type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, { button, cancelable: true, bubbles: true })
  window.dispatchEvent(event)
  return event
}

describe('navigationHistory', () => {
  // Once, not per test: init() registers window listeners that have no
  // teardown by design (see the module's own note), so calling it again
  // would leave the previous run's listeners firing alongside this one's.
  beforeAll(() => {
    initNavigationHistory()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    navigatedTo({})
  })

  it('has nowhere to go at the first page of the session', () => {
    expect(navigationHistory.canGoBack).toBe(false)
    expect(navigationHistory.canGoForward).toBe(false)
  })

  it('opens up once the history has something behind the current page', () => {
    navigatedTo({ back: '/artists/42' })

    expect(navigationHistory.canGoBack).toBe(true)
    expect(navigationHistory.canGoForward).toBe(false)
  })

  it('offers forward again after going back', () => {
    navigatedTo({ back: '/artists', forward: '/albums/7' })

    expect(navigationHistory.canGoBack).toBe(true)
    expect(navigationHistory.canGoForward).toBe(true)
  })

  it('does nothing when there is nothing behind the current page', () => {
    goBack()
    goForward()

    expect(router.back).not.toHaveBeenCalled()
    expect(router.forward).not.toHaveBeenCalled()
  })

  it('walks the router history when there is somewhere to go', () => {
    navigatedTo({ back: '/artists/42', forward: '/albums/7' })

    goBack()
    goForward()

    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.forward).toHaveBeenCalledTimes(1)
  })

  it('answers the mouse back and forward buttons', () => {
    navigatedTo({ back: '/artists/42', forward: '/albums/7' })

    mouse('mouseup', 3)
    expect(router.back).toHaveBeenCalledTimes(1)

    mouse('mouseup', 4)
    expect(router.forward).toHaveBeenCalledTimes(1)
  })

  it('leaves the ordinary mouse buttons alone', () => {
    navigatedTo({ back: '/artists/42' })

    const left = mouse('mouseup', 0)
    const middle = mouse('mouseup', 1)

    expect(router.back).not.toHaveBeenCalled()
    expect(left.defaultPrevented).toBe(false)
    expect(middle.defaultPrevented).toBe(false)
  })

  /** The press is taken away from the browser so that, in the web build,
   * it cannot navigate a second time on top of the router.back() above. */
  it('takes the press away from the browser for the history buttons', () => {
    expect(mouse('mousedown', 3).defaultPrevented).toBe(true)
    expect(mouse('mousedown', 4).defaultPrevented).toBe(true)
    expect(mouse('mousedown', 0).defaultPrevented).toBe(false)
  })
})
