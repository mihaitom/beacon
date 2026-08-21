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
}
