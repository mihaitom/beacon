import { watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

/** Stable per-account tag for namespacing device-local settings — `null`
 * pre-login (nothing to namespace by yet; accountScopedKey() below falls
 * back to the un-namespaced key in that case, matching today's pre-login
 * behavior).
 *
 * username, not a Plex account UUID: available for all three server types
 * today (Subsonic/Jellyfin login, and Plex's plex.tv/api/v2/user response —
 * see connect/media/plex.py's get_account_username()) with no backend
 * change needed. Slightly less stable for Plex specifically (a renamed
 * Plex username buckets as "new"), accepted as a known, rare edge case.
 *
 * Only serverUrl is required, not username: selectPlexServer() deliberately
 * tolerates an empty username when the plex.tv lookup came up empty (see
 * its own comment), and demanding one here would silently switch this
 * whole feature *off* for exactly those installs — no scoping, and
 * onAccountChange() never firing, so update/playback/lyrics would never
 * reload for the account either. Falling back to a per-server scope
 * (`plex|url|`) is a far better answer than no scope at all. */
export function getAccountKey(): null | string {
  const auth = useAuthStore()
  if (!auth.serverUrl) return null
  return `${auth.serverType}|${auth.serverUrl}|${auth.username}`
}

/** Namespaces `baseKey` (e.g. 'beacon.quality') by the current account —
 * different accounts on the same device/browser get independent values
 * instead of silently sharing (or worse, one account's cached
 * library/queue briefly showing up under a different account that just
 * logged in). The same account still gets independent values per device,
 * since this only touches the key, not where it's stored (localStorage
 * stays device-local).
 *
 * Migrates a pre-existing un-namespaced value into the new key exactly
 * once, the first time some account reads it post-upgrade — otherwise
 * every current single-account install would silently reset its settings
 * the moment this ships. Only the first account to read a given key gets
 * the migrated value; every other account correctly gets a fresh default
 * rather than inheriting it.
 *
 * The migration is destructive (it *moves* the value), so it waits for
 * `authenticated` rather than just for an identity to exist: login() and
 * selectPlexServer() both set serverUrl/username *before* authenticating,
 * so a single typo'd username would otherwise move every legacy key —
 * quality, the resume snapshot, the library cache, the dismissed update —
 * into a scope belonging to an account that doesn't exist, and delete the
 * original. The real login right after would then come up empty. Reads
 * still namespace normally while unauthenticated; only the one-way move
 * waits. */
export function accountScopedKey(baseKey: string): string {
  const accountKey = getAccountKey()
  if (!accountKey) return baseKey
  const scoped = `${baseKey}::${accountKey}`
  if (localStorage.getItem(scoped) === null && useAuthStore().authenticated) {
    const legacy = localStorage.getItem(baseKey)
    if (legacy !== null) {
      localStorage.setItem(scoped, legacy)
      localStorage.removeItem(baseKey)
    }
  }
  return scoped
}

/** Fires `callback` whenever the current account identity actually changes
 * — including the very first time it resolves after login. Exists for the
 * stores that bake an account-scoped read into a Pinia `state()` factory
 * (or an equivalent module-level singleton cache): that only ever runs
 * once per store instance, and several of those stores (playback, update)
 * get created at app boot — before login/restore() has resolved who's
 * actually logged in — via App.vue's created(). Without this, they'd stay
 * stuck on whichever account was (or wasn't) live the moment they were
 * first created, for the rest of the app session.
 *
 * Gated on `authenticated` for the same reason accountScopedKey()'s
 * migration is: the identity fields are already populated mid-login, so an
 * unfiltered watcher would fire once for a half-typed/failed login (pulling
 * server settings for, and reloading every store into, a scope that isn't
 * anyone's) before firing again for the real account.
 *
 * Call once per affected store/module, from services/accountScopedStores.ts
 * (wired up once from App.vue's created(), which is guaranteed to run
 * after Pinia is active — unlike a raw module-top-level call here, which
 * would call useAuthStore() before Pinia might exist). */
export function onAccountChange(callback: () => void): void {
  watch(
    () => (useAuthStore().authenticated ? getAccountKey() : null),
    (accountKey) => {
      if (accountKey !== null) callback()
    },
  )
}
