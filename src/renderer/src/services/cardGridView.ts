/**
 * Whether a `CardShelf` is showing its cards as a wrapping grid rather than
 * as one scrolling row, remembered per shelf across visits.
 *
 * A layout choice that resets every time you navigate back to a page is
 * worse than not offering it at all — the same reasoning as
 * NowPlayingView.vue's own visualizer preference. Shelf is the default, so
 * a missing (or unreadable) value means shelf.
 *
 * Shared rather than written per view: the favorites page and the search
 * results both offer this, and a third caller would otherwise be a third
 * copy of the same two try/catch blocks (see CardShelf.vue's own comment on
 * why that component exists at all).
 */

import { readBooleanPreference, writeBooleanPreference } from './booleanPreference'

/** One key per shelf, e.g. `beacon.favoritesGridView.artists`. Deliberately
 * not account-scoped: which way a row is laid out is a property of the
 * screen in front of the person, not of the account signed in to it. */
export function readCardGridView(key: string): boolean {
  return readBooleanPreference(key)
}

export function writeCardGridView(key: string, value: boolean): void {
  writeBooleanPreference(key, value)
}
