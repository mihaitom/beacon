/**
 * The countries somebody picked before, pinned above the alphabetical list
 * in every country picker in the app.
 *
 * Shared by the radio station directory (RadioDiscoverDialog.vue) and the
 * Last.fm playlist builder (LastfmPlaylistDialog.vue), and deliberately one
 * list rather than one per picker: a household listens to the same two or
 * three countries whichever of the two it is looking at, and having picked
 * "Ireland" for stations is a good reason to offer it for charts too.
 *
 * Stored as ISO 3166-1 *codes* even though Last.fm's own API wants names
 * (see connect/core/lastfm.py): a code is the stable identifier both
 * pickers can map back to whatever they display, and it is what was
 * already on disk when this was pulled out of the radio dialog.
 */

import { accountScopedKey } from './accountKey'

// Five, not more: the point is that the two or three countries somebody
// actually listens to are one glance away, and a longer block would push
// the alphabetical list off the first screen of the menu - at which point
// every pick needs scrolling again.
export const RECENT_COUNTRY_LIMIT = 5

// Still the radio dialog's original key, which is where this list has
// lived on every existing install - renaming it to something neutral now
// would silently throw away what everyone has already picked.
const STORAGE_KEY = 'beacon.radioDiscoverRecentCountries'

export function loadRecentCountries(): string[] {
  try {
    const raw = localStorage.getItem(accountScopedKey(STORAGE_KEY))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((code): code is string => typeof code === 'string' && code !== '')
      .slice(0, RECENT_COUNTRY_LIMIT)
  } catch {
    // Unreadable/corrupt storage costs the shortcut, nothing else.
    return []
  }
}

export function saveRecentCountries(codes: string[]): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(codes))
  } catch {
    // Storage full/unavailable - the pinned block still works for this
    // session, it just starts empty next time.
  }
}

/** The list with `code` moved to the front, capped at
 * RECENT_COUNTRY_LIMIT. Pure so that both an initial read and every later
 * selection go through the same rule; an empty code (a picker's clear
 * button) leaves the list alone rather than emptying it - "no country" is
 * not a country somebody picked. */
export function withRecentCountry(codes: string[], code: string | null): string[] {
  if (!code) return codes
  return [code, ...codes.filter((existing) => existing !== code)].slice(0, RECENT_COUNTRY_LIMIT)
}

/** The break between the pinned block and the alphabetical list.
 * `type: 'divider'` is Vuetify's own item shape for this; name/code are
 * empty only so that the title/value it derives from every item stay out
 * of the rendered element's attributes. Vuetify drops the divider by
 * itself while typing filters the list down to one side of it. */
export type CountryDividerItem = { type: 'divider'; name: ''; code: '' }
export const COUNTRY_DIVIDER: CountryDividerItem = { type: 'divider', name: '', code: '' }

/** `options` reordered so the recently picked ones come first, separated
 * from the rest by a divider. A recent country is *moved* rather than
 * copied, so typing into a picker never turns up the same country twice -
 * and so the selected row is the selected row, instead of two rows both
 * drawn as active. Unknown codes (a country that dropped out of the
 * directory, or a list written before the options loaded) fall out
 * silently. */
export function pinRecentCountries<T extends { code: string }>(
  options: T[],
  recentCodes: string[],
): (T | CountryDividerItem)[] {
  const recent = recentCodes
    .map((code) => options.find((option) => option.code === code))
    .filter((option): option is T => option !== undefined)
  if (recent.length === 0) return options
  const pinned = new Set(recent.map((option) => option.code))
  return [...recent, COUNTRY_DIVIDER, ...options.filter((option) => !pinned.has(option.code))]
}
