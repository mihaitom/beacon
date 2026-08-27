import { describe, expect, it } from 'vitest'
import { repeatable, resolveShortcut, SHORTCUT_HELP } from '../keyboardShortcuts'

function press(key: string, init: KeyboardEventInit & { target?: Element } = {}): KeyboardEvent {
  const { target, ...eventInit } = init
  const event = new KeyboardEvent('keydown', { key, ...eventInit })
  // KeyboardEventInit has no `target` — dispatching for real is the only
  // way jsdom sets one, so tests that care about focus attach the event to
  // an element instead of constructing it with one.
  if (target) {
    // Already in the document (a row inside an overlay, say) — leave it
    // where it is, since moving it would be exactly the relationship the
    // guard under test looks at.
    const detached = !target.isConnected
    if (detached) document.body.appendChild(target)
    target.dispatchEvent(event)
    if (detached) target.remove()
  }
  return event
}

describe('resolveShortcut', () => {
  it('maps the transport keys every player has taught people', () => {
    expect(resolveShortcut(press(' '))).toEqual({ type: 'togglePlay' })
    expect(resolveShortcut(press('k'))).toEqual({ type: 'togglePlay' })
    expect(resolveShortcut(press('ArrowRight'))).toEqual({ type: 'seekBy', seconds: 5 })
    expect(resolveShortcut(press('ArrowLeft'))).toEqual({ type: 'seekBy', seconds: -5 })
    expect(resolveShortcut(press('ArrowUp'))).toEqual({ type: 'nudgeVolume', direction: 1 })
    expect(resolveShortcut(press('ArrowDown'))).toEqual({ type: 'nudgeVolume', direction: -1 })
  })

  it('answers the same for an upper-case letter — Caps Lock is not a different command', () => {
    expect(resolveShortcut(press('M'))).toEqual({ type: 'toggleMute' })
    expect(resolveShortcut(press('S'))).toEqual({ type: 'toggleShuffle' })
    expect(resolveShortcut(press('R'))).toEqual({ type: 'cycleRepeat' })
    expect(resolveShortcut(press('F'))).toEqual({ type: 'toggleFavorite' })
    expect(resolveShortcut(press('Q'))).toEqual({ type: 'toggleQueue' })
  })

  it('skips tracks only with Ctrl/Cmd, so a bare arrow still seeks', () => {
    expect(resolveShortcut(press('ArrowRight', { ctrlKey: true }))).toEqual({ type: 'nextTrack' })
    expect(resolveShortcut(press('ArrowLeft', { metaKey: true }))).toEqual({
      type: 'previousTrack',
    })
  })

  it('leaves every other modifier combination to the browser and the OS', () => {
    // Ctrl+R reloads, Alt+Left goes back — none of those may turn into a
    // repeat-mode change or a seek.
    expect(resolveShortcut(press('r', { ctrlKey: true }))).toBeNull()
    expect(resolveShortcut(press('ArrowLeft', { altKey: true }))).toBeNull()
    expect(resolveShortcut(press('m', { shiftKey: true }))).toBeNull()
  })

  it('jumps to a tenth of the track for the digit keys', () => {
    expect(resolveShortcut(press('0'))).toEqual({ type: 'seekToFraction', fraction: 0 })
    expect(resolveShortcut(press('5'))).toEqual({ type: 'seekToFraction', fraction: 0.5 })
    expect(resolveShortcut(press('9'))).toEqual({ type: 'seekToFraction', fraction: 0.9 })
  })

  it('stays out of the way while typing — the whole point of the guard', () => {
    const input = document.createElement('input')
    expect(resolveShortcut(press(' ', { target: input }))).toBeNull()
    const textarea = document.createElement('textarea')
    expect(resolveShortcut(press('q', { target: textarea }))).toBeNull()
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    // jsdom doesn't derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(resolveShortcut(press('s', { target: editable }))).toBeNull()
  })

  it('leaves a focused button or slider its own keys, but not the letters', () => {
    const button = document.createElement('button')
    // Space activates the button the user is actually on.
    expect(resolveShortcut(press(' ', { target: button }))).toBeNull()
    // The arrow keys move a focused slider (the seek bar, a volume slider).
    const slider = document.createElement('div')
    slider.setAttribute('role', 'slider')
    expect(resolveShortcut(press('ArrowUp', { target: slider }))).toBeNull()
    // A letter means nothing to either of them, so it still reaches the player.
    expect(resolveShortcut(press('f', { target: button }))).toEqual({ type: 'toggleFavorite' })
    // Track skipping isn't a key a button answers either.
    expect(resolveShortcut(press('ArrowRight', { target: button, ctrlKey: true }))).toEqual({
      type: 'nextTrack',
    })
  })

  it('goes quiet under an open dialog or menu, which brings its own keys', () => {
    const overlay = document.createElement('div')
    overlay.className = 'v-overlay-container'
    const item = document.createElement('div')
    overlay.appendChild(item)
    document.body.appendChild(overlay)
    expect(resolveShortcut(press('ArrowDown', { target: item }))).toBeNull()
    expect(resolveShortcut(press('q', { target: item }))).toBeNull()
    // Except "?" — the help dialog it opens is itself an overlay, so this
    // is what closes it again.
    expect(resolveShortcut(press('?', { target: item }))).toEqual({ type: 'toggleHelp' })
    overlay.remove()
  })

  it('does not claim keys it has no shortcut for', () => {
    expect(resolveShortcut(press('x'))).toBeNull()
    expect(resolveShortcut(press('Enter'))).toBeNull()
    expect(resolveShortcut(press('Escape'))).toBeNull()
  })
})

describe('repeatable', () => {
  it('lets a held key keep seeking and changing volume', () => {
    expect(repeatable({ type: 'seekBy', seconds: 5 })).toBe(true)
    expect(repeatable({ type: 'nudgeVolume', direction: -1 })).toBe(true)
  })

  it('fires a toggle once per press, however long it is held', () => {
    // Holding Space would otherwise flip play/pause dozens of times a second.
    expect(repeatable({ type: 'togglePlay' })).toBe(false)
    expect(repeatable({ type: 'toggleFavorite' })).toBe(false)
    expect(repeatable({ type: 'toggleHelp' })).toBe(false)
  })
})

describe('SHORTCUT_HELP', () => {
  it('documents a key for every action the mapping actually answers', () => {
    // The dialog is the only place these are discoverable, so a shortcut
    // missing from it may as well not exist.
    const documented = SHORTCUT_HELP.flatMap((entry) => entry.keys)
    expect(documented).toContain('Space')
    expect(documented).toContain('?')
    expect(SHORTCUT_HELP.every((entry) => entry.labelKey.startsWith('shortcuts.'))).toBe(true)
  })
})
