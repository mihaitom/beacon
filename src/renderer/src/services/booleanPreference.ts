/**
 * A yes/no preference remembered across visits — whether a shelf is a grid
 * rather than a row, whether the search matches whole words only.
 *
 * Deliberately not account-scoped: it is a property of the screen in front of
 * the person, not of the account signed in to it. Shared so each caller is
 * not another copy of the same two try/catch blocks (see cardGridView.ts,
 * which this backs).
 */

/** The stored value, or `fallback` when nothing was stored or storage is
 * unreadable (private mode, blocked storage). */
export function readBooleanPreference(key: string, fallback = false): boolean {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? fallback : stored === 'true'
  } catch {
    return fallback
  }
}

export function writeBooleanPreference(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // The toggle still works for this visit, it just won't be remembered.
  }
}
