import type Toast from './toast'

/** Shorthand form for emitter.emit('toast', ...) — [level, title, message]. */
export type ToastTuple = [Toast['level'], string, string]

export type AppEvents = {
  toast: Toast | ToastTuple
  openReleaseNotes: void
  // Broadcast by SongRow.vue's openMenu() with its own menuId — every other
  // mounted SongRow closes its context menu on receiving one that isn't its
  // own. Each row's v-menu is independent local state (its own menuOpen),
  // so without this, right-clicking row B never told row A's already-open
  // menu to close, and several could end up open/stacked at once.
  contextMenuOpened: number
  // Opens/closes the keyboard-shortcut reference (KeyboardShortcutsDialog.vue,
  // mounted once in App.vue). An event rather than store state: the dialog is
  // pure UI with nothing else in the app reading whether it happens to be
  // open, and both of its triggers (the "?" key, the Settings entry) sit far
  // away from where it's mounted.
  toggleKeyboardShortcuts: void
  // Opens the full-size artwork viewer (ArtworkLightbox.vue, mounted once in
  // App.vue). Same reasoning as toggleKeyboardShortcuts above — pure UI
  // nothing else reads — and the same shape suits it especially well here:
  // its triggers (a detail header's artwork, a song row's context menu, an
  // album/artist card's) sit in components spread across the library, none
  // of which should have to thread a dialog through their own parents.
  showArtwork: ArtworkView
}

/** What the artwork viewer needs to show one picture: whichever of the two
 * sources the artwork has (a cover art id resolved through the batch
 * endpoint, or a ready-made artist photo URL — see CoverArt.vue's own
 * props), plus what to name it underneath. */
export interface ArtworkView {
  // Both nullable, matching what the library's own types hand out (an album
  // with no cover, an artist with no photo) and what CoverArt.vue's props
  // already accept — so a caller passes its item's field straight through
  // rather than converting it on the way.
  coverArtId?: string | null
  imageUrl?: string | null
  title: string
  subtitle?: string
  /** Artists are shown as circles everywhere else in the app; passing this
   * through keeps the viewer from squaring one off. */
  rounded?: boolean
  fallbackIcon?: string
}
