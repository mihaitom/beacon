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
  autoplayBatchSize?: number
}

function identity(): { server_type: string; server_url: string; username: string } {
  const auth = useAuthStore()
  return { server_type: auth.serverType, server_url: auth.serverUrl, username: auth.username }
}

/** `{}` for an account that has never synced anything — not an error, see
 * connect/core/account_settings.py's load(). */
export function fetchAccountSettings(): Promise<AccountSettingsPayload> {
  const params = new URLSearchParams(identity())
  return fetchConnect<AccountSettingsPayload>(`/account-settings?${params.toString()}`)
}

/** Merges `patch` into whatever this account has already synced — a caller
 * only ever needs to name the one field it just changed (see each setter's
 * own pushAccountSettings() call), never the whole payload. */
export function pushAccountSettings(
  patch: AccountSettingsPayload,
): Promise<AccountSettingsPayload> {
  return fetchConnect<AccountSettingsPayload>('/account-settings', {
    method: 'POST',
    body: { ...identity(), settings: patch },
  })
}
