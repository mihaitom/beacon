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
}
