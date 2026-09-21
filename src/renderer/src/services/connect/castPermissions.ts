import { fetchConnect } from './http'

export type CastPermissionMode = 'allowlist' | 'blocklist'

/** The server-wide cast policy (see connect/core/cast_permissions.py and
 * docs/cast-permissions.md).
 *
 * `mode` says what the listed accounts get: `allowlist` means they may
 * cast, `blocklist` means they may not. `default_allow` says what accounts
 * *not* on the list get, which is also what a brand-new account gets. With
 * no list and `default_allow` true, everyone may cast.
 *
 * `suggested_accounts` are the names to offer in the picker, and
 * `lists_users` says whether they are the server's full account list
 * (Jellyfin) or only the accounts that have signed in to this Beacon
 * (Navidrome, whose Subsonic API never lists its other users) — the UI
 * words itself differently for the two so a partial list is never mistaken
 * for the whole server. */
export interface CastPermissions {
  accounts: string[]
  mode: CastPermissionMode
  default_allow: boolean
  suggested_accounts: string[]
  lists_users: boolean
}

export interface CastPermissionsUpdate {
  accounts: string[]
  mode: CastPermissionMode
  default_allow: boolean
}

export async function getCastPermissions(): Promise<CastPermissions> {
  return await fetchConnect<CastPermissions>('/cast-permissions')
}

export async function setCastPermissions(
  update: CastPermissionsUpdate,
): Promise<Omit<CastPermissions, 'suggested_accounts' | 'lists_users'>> {
  return await fetchConnect<Omit<CastPermissions, 'suggested_accounts' | 'lists_users'>>(
    '/cast-permissions',
    { method: 'PUT', body: update },
  )
}
