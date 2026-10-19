import { fetchConnect } from './http'
import { useAuthStore } from '@/stores/auth'

/** The settings that follow an account across devices — see
 * connect/core/account_settings.py's own docstring. Every field optional:
 * GET only ever returns whatever some device has actually pushed before,
 * never a placeholder for the rest. Keys travel to/from the wire exactly
 * as they are here (the backend stores `settings` as an opaque dict, see
 * routes/account_settings.py) — only the identity wrapper below needs to
 * match its Pydantic model's snake_case field names. */
export interface AccountSettingsPayload {
  locale?: string
  recommendationsEnabled?: boolean
  lyricsProviders?: string[]
  // The opt-out for casting radio straight to the device instead of
  // through Beacon's own relay (core/radio_relay.py) — see
  // stores/radioSettings.ts. Absent/false is the default (relayed).
  castRadioDirectly?: boolean
  // The Last.fm name the playlist builder reads a listening history
  // for - see stores/lastfm.ts. A public profile name, not a credential.
  lastfmUsername?: string
  // The ListenBrainz name the builder and Home's personalized shelf read
  // from - see stores/listenbrainz.ts. Also a public profile name.
  listenbrainzUsername?: string
  // Which optional columns the song tables show - see
  // stores/songColumns.ts. An empty array is a real selection (every
  // optional column off), not "never set".
  songColumns?: string[]
  // Whether artist artwork from Fanart.tv is shown at all - see
  // stores/fanart.ts. The API key is installation-wide and stays stored;
  // this only decides whether the images are asked for.
  fanartEnabled?: boolean
  // Gapless and crossfade - see stores/transitions.ts.
  transitions?: { mode: string; crossfadeSeconds: number; beatmixBars: number }
}

function identity(): { server_type: string; server_url: string; username: string } {
  const auth = useAuthStore()
  return { server_type: auth.serverType, server_url: auth.serverUrl, username: auth.username }
}

// What the server holds for this account, as far as this window knows -
// from the last fetch and every push since. Applying a pulled value goes
// through each setting's own setter, which pushes it straight back; this
// is what turns that echo into nothing instead of a write per setting on
// every start.
let synced: { account: string; settings: AccountSettingsPayload } | null = null

function accountKey(): string {
  return JSON.stringify(identity())
}

/** JSON with object keys in a fixed order - a setter rebuilds an object
 * setting (transitions) in its own key order, which is still the same
 * value as the one the server sent. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  )
}

function syncedSettings(): AccountSettingsPayload {
  return synced?.account === accountKey() ? synced.settings : {}
}

/** `{}` for an account that has never synced anything — not an error, see
 * connect/core/account_settings.py's load(). */
export async function fetchAccountSettings(): Promise<AccountSettingsPayload> {
  const account = accountKey()
  const params = new URLSearchParams(identity())
  const settings = await fetchConnect<AccountSettingsPayload>(
    `/account-settings?${params.toString()}`,
  )
  synced = { account, settings: { ...settings } }
  return settings
}

/** Merges `patch` into whatever this account has already synced — a caller
 * only ever needs to name the one field it just changed (see each setter's
 * own pushAccountSettings() call), never the whole payload. Fields the
 * server already holds with exactly this value are left out, and with
 * none left nothing is sent. */
export async function pushAccountSettings(
  patch: AccountSettingsPayload,
): Promise<AccountSettingsPayload> {
  const account = accountKey()
  const known = syncedSettings()
  const changed = Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) => canonical(value) !== canonical(known[key as keyof AccountSettingsPayload]),
    ),
  ) as AccountSettingsPayload
  if (Object.keys(changed).length === 0) return { ...known }
  const merged = await fetchConnect<AccountSettingsPayload>('/account-settings', {
    method: 'POST',
    body: { ...identity(), settings: changed },
  })
  if (accountKey() === account) synced = { account, settings: { ...known, ...changed } }
  return merged
}
