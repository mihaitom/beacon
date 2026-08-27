import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { nudgeVolume, toggleMute } from '@/services/volumeControl'
import { emitter } from '@/emitter'

/**
 * In-app keyboard shortcuts. Separate from the OS media keys
 * (mediaSession.ts) — those come from outside the window and only cover
 * play/pause/skip/seek; these are the ones a player is expected to answer
 * while it has focus, casting included (every action below routes through
 * the same store actions the on-screen controls call, so none of them care
 * whether audio is coming from here or from a speaker).
 */

/** How far one arrow-key press seeks. Matches what most players settle on
 * — small enough to nudge past a spoken intro, not a scrub replacement
 * (that's the seek bar). */
const SEEK_STEP_SECONDS = 5

export type ShortcutAction =
  | { type: 'togglePlay' }
  | { type: 'seekBy'; seconds: number }
  | { type: 'seekToFraction'; fraction: number }
  | { type: 'previousTrack' }
  | { type: 'nextTrack' }
  | { type: 'nudgeVolume'; direction: 1 | -1 }
  | { type: 'toggleMute' }
  | { type: 'toggleShuffle' }
  | { type: 'cycleRepeat' }
  | { type: 'toggleFavorite' }
  | { type: 'toggleQueue' }
  | { type: 'toggleHelp' }

/**
 * Typing must never reach a shortcut — Space in the search field belongs to
 * the search field, not to play/pause. Covers the three form elements plus
 * anything contenteditable.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  if (element.isContentEditable) return true
  return ['input', 'textarea', 'select'].includes(element.tagName.toLowerCase())
}

/**
 * Anything inside an open dialog/menu/select popup — those bring their own
 * key handling (arrow keys walk a menu, Escape closes it), and a shortcut
 * firing underneath would act on a player the user isn't looking at.
 * Vuetify teleports every overlay's content into one container, so this
 * single check covers all of them without naming each component.
 */
function isInsideOverlay(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.closest !== 'function') return false
  return element.closest('.v-overlay-container') !== null
}

/**
 * A control that answers these keys itself: Space/Enter activate a button,
 * the arrow keys move a focused slider (the seek bar, a volume slider).
 * Stealing those would break the on-screen control the user is actually
 * operating — so while focus sits on one, only the letter/digit shortcuts
 * still apply.
 */
function ownsNavigationKeys(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.closest !== 'function') return false
  return (
    element.closest(
      'button, a[href], [role="button"], [role="switch"], [role="tab"], [role="slider"], .v-slider',
    ) !== null
  )
}

const NAVIGATION_KEYS = [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

/**
 * The action a key press asks for, or null if it isn't one of ours.
 *
 * Split out from the listener below so the whole mapping — including the
 * modifier and typing rules that are easy to get subtly wrong — is
 * testable without a DOM, a store, or actual playback.
 */
export function resolveShortcut(event: KeyboardEvent): ShortcutAction | null {
  if (event.altKey) return null
  if (isTypingTarget(event.target)) return null

  // Checked before the overlay guard: the help dialog is itself an overlay,
  // so gating this on "no overlay open" would leave the same key that opens
  // it unable to close it again.
  if (event.key === '?') return { type: 'toggleHelp' }
  if (isInsideOverlay(event.target)) return null

  // Ctrl/Cmd is the track-skip modifier (matching Spotify's own web
  // player); every other shortcut here is unmodified, so a browser/OS
  // binding like Ctrl+R or Cmd+Q keeps going where it always went.
  const skipModifier = event.ctrlKey || event.metaKey
  if (skipModifier) {
    if (event.key === 'ArrowLeft') return { type: 'previousTrack' }
    if (event.key === 'ArrowRight') return { type: 'nextTrack' }
    return null
  }
  if (event.shiftKey) return null
  // After the Ctrl/Cmd branch above: a focused button doesn't answer
  // Ctrl+Arrow itself, so track skipping still works from anywhere.
  if (NAVIGATION_KEYS.includes(event.key) && ownsNavigationKeys(event.target)) return null

  switch (event.key) {
    // ' ' is what a KeyboardEvent reports for the space bar; 'k' comes
    // along for the ride because every video/music player on the web has
    // taught people it means the same thing.
    case ' ':
    case 'k':
    case 'K':
      return { type: 'togglePlay' }
    case 'ArrowLeft':
      return { type: 'seekBy', seconds: -SEEK_STEP_SECONDS }
    case 'ArrowRight':
      return { type: 'seekBy', seconds: SEEK_STEP_SECONDS }
    case 'ArrowUp':
      return { type: 'nudgeVolume', direction: 1 }
    case 'ArrowDown':
      return { type: 'nudgeVolume', direction: -1 }
    case 'm':
    case 'M':
      return { type: 'toggleMute' }
    case 's':
    case 'S':
      return { type: 'toggleShuffle' }
    case 'r':
    case 'R':
      return { type: 'cycleRepeat' }
    case 'f':
    case 'F':
      return { type: 'toggleFavorite' }
    case 'q':
    case 'Q':
      return { type: 'toggleQueue' }
    default:
      // 0-9 jump to that tenth of the track, 0 being the start.
      if (event.key.length === 1 && event.key >= '0' && event.key <= '9') {
        return { type: 'seekToFraction', fraction: Number(event.key) / 10 }
      }
      return null
  }
}

/**
 * Whether a held-down key should keep firing. Seeking and volume are
 * continuous — holding the key is how you cover distance with them. Every
 * toggle is not: holding Space would otherwise flip play/pause dozens of
 * times a second.
 */
export function repeatable(action: ShortcutAction): boolean {
  return action.type === 'seekBy' || action.type === 'nudgeVolume'
}

async function toggleFavorite(): Promise<void> {
  const song = usePlaybackStore().currentSong
  if (!song) return
  const wasStarred = song.starred
  await useLibraryStore().toggleStar({ id: song.id, starred: wasStarred })
  // Flips the captured song rather than whatever is current by now — the
  // track can advance during the round trip, same as SongInfo.vue's own
  // heart button.
  song.starred = !wasStarred
}

async function runShortcut(action: ShortcutAction): Promise<void> {
  const playback = usePlaybackStore()
  switch (action.type) {
    case 'togglePlay':
      await playback.togglePlay()
      return
    case 'seekBy': {
      // Nothing loaded, or a radio stream (no duration to seek within) —
      // seek() itself would happily take a position either way.
      if (!playback.duration) return
      const target = playback.localPosition + action.seconds
      await playback.seek(Math.min(playback.duration, Math.max(0, target)))
      return
    }
    case 'seekToFraction':
      if (!playback.duration) return
      await playback.seek(playback.duration * action.fraction)
      return
    case 'previousTrack':
      await playback.playPrevious()
      return
    case 'nextTrack':
      await playback.playNext()
      return
    case 'nudgeVolume':
      await nudgeVolume(action.direction)
      return
    case 'toggleMute':
      await toggleMute()
      return
    case 'toggleShuffle':
      playback.toggleShuffle()
      return
    case 'cycleRepeat':
      playback.cycleRepeatMode()
      return
    case 'toggleFavorite':
      await toggleFavorite()
      return
    case 'toggleQueue':
      playback.toggleQueueDrawer()
      return
    case 'toggleHelp':
      emitter.emit('toggleKeyboardShortcuts')
      return
  }
}

/** Called once from App.vue. The listener lives as long as the window
 * does, so there's nothing to tear down — every layout (desktop, mobile
 * web) shares it, and a device without a keyboard simply never fires it. */
export function initKeyboardShortcuts(): void {
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const action = resolveShortcut(event)
    if (!action) return
    if (event.repeat && !repeatable(action)) return
    // Only once something has actually claimed the key: Space would
    // otherwise stop scrolling the page even where it isn't a shortcut,
    // and the arrow keys would stop moving the caret.
    event.preventDefault()
    // Caught here rather than per action — a failed volume call to a cast
    // device shouldn't surface as an unhandled rejection, and there's
    // nothing useful to tell the user about a key press that didn't take.
    void runShortcut(action).catch((error) =>
      console.error('[shortcuts] Failed to run', action.type, error),
    )
  })
}

/** One row of the help dialog (KeyboardShortcutsDialog.vue). Each entry in
 * `keys` is a full alternative for the same action ("Space" *or* "K"), and
 * a combination is written with a "+" for the dialog to split into
 * separate keycaps. Kept next to the mapping above so a shortcut and its
 * documentation can't drift apart. */
export interface ShortcutHelpEntry {
  keys: string[]
  labelKey: string
}

export const SHORTCUT_HELP: ShortcutHelpEntry[] = [
  { keys: ['Space', 'K'], labelKey: 'shortcuts.togglePlay' },
  { keys: ['←', '→'], labelKey: 'shortcuts.seek' },
  { keys: ['Ctrl + ←', 'Ctrl + →'], labelKey: 'shortcuts.skipTrack' },
  { keys: ['↑', '↓'], labelKey: 'shortcuts.volume' },
  { keys: ['M'], labelKey: 'shortcuts.mute' },
  { keys: ['S'], labelKey: 'shortcuts.shuffle' },
  { keys: ['R'], labelKey: 'shortcuts.repeat' },
  { keys: ['F'], labelKey: 'shortcuts.favorite' },
  { keys: ['Q'], labelKey: 'shortcuts.queue' },
  { keys: ['0 – 9'], labelKey: 'shortcuts.jump' },
  { keys: ['?'], labelKey: 'shortcuts.help' },
]
