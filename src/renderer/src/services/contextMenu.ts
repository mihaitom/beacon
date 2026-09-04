/**
 * Shared bookkeeping for every context menu in the app — song rows, library
 * tiles, radio stations. All of them are the same interaction (right-click
 * something, get a list of actions for it), and the two rules that make it
 * behave like a real context menu are rules *between* menus rather than
 * inside any one of them:
 *
 *   - only one is ever open, and
 *   - the next right-click anywhere closes whatever is open.
 *
 * Both work through the `contextMenuOpened` bus: a menu announces its own id
 * when it opens, and every menu closes on hearing an id that isn't its own.
 */
import { emitter } from '@/emitter'

/** An id no menu can have — broadcast to close all of them without opening
 * anything (see the document listener below). */
const NO_MENU = 0

let next = NO_MENU

/** A fresh id for one menu instance.
 *
 * Unique across *all* menus, not just one kind: a per-component counter
 * hands the first song row and the first album tile the same number, and
 * each then reads the other's broadcast as its own and stays open. */
export function nextContextMenuId(): number {
  next += 1
  installGlobalDismiss()
  return next
}

let installed = false

/** Closes any open menu on the next right-click anywhere.
 *
 * Vuetify already dismisses an overlay on a left click outside it, but not
 * on a right one: the click-outside handling listens for `click`, which a
 * context-menu press never fires. Without this, right-clicking the page
 * background (or any element with no menu of its own) left the previous
 * menu sitting open, and a second one could be opened beside it by
 * right-clicking a tile whose own broadcast the first one had already been
 * closed by — visibly two menus at once.
 *
 * Capture phase, so this runs before the tile handler that is about to open
 * *its* menu on the same event: the close-everything broadcast lands first,
 * the new menu opens after it. On bubble it would close the menu that just
 * opened. */
function installGlobalDismiss(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener(
    'contextmenu',
    () => {
      emitter.emit('contextMenuOpened', NO_MENU)
    },
    { capture: true },
  )
}
