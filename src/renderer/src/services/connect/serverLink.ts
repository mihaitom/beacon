import { fetchConnect } from './http'

/** Why a pairing cannot do its work right now, or why one was refused - see
 * connect/core/server_link.py. */
export type ServerLinkState =
  | 'connected'
  | 'wrong_key'
  | 'unreachable'
  | 'server_too_old'
  | 'blocked'
  | 'other_account'
  | 'key_of_another_account'
  | 'invalid_url'
  | 'insecure_url'

/** This desktop's pairing with a Beacon server. The key is only ever sent
 * here, never read back. */
export interface ServerLinkStatus {
  /** False on a Docker install, which has no use for it. */
  available: boolean
  linked: boolean
  url?: string
  remote_username?: string
  state?: ServerLinkState
  /** UTC seconds. */
  last_sync_at?: number | null
  unsent?: number
  /** Set when a pairing attempt was refused. */
  error?: ServerLinkState
}

export function getServerLink(): Promise<ServerLinkStatus> {
  return fetchConnect<ServerLinkStatus>('/server-link')
}

export function pairServerLink(url: string, key: string): Promise<ServerLinkStatus> {
  return fetchConnect<ServerLinkStatus>('/server-link', { method: 'PUT', body: { url, key } })
}

export function unpairServerLink(): Promise<ServerLinkStatus> {
  return fetchConnect<ServerLinkStatus>('/server-link', { method: 'DELETE' })
}

export type DeviceKeyScope = 'sync' | 'api_keys' | AppScope
export type AppScope = 'history' | 'stats' | 'now_playing' | 'lyrics' | 'control' | 'library'

export const APP_SCOPES: readonly AppScope[] = [
  'history',
  'stats',
  'now_playing',
  'lyrics',
  'control',
  'library',
]

export interface DeviceKey {
  id: string
  label: string
  /** UTC seconds. */
  created_at: number
  last_used_at: number | null
  /** The device has checked in recently, so it is connected right now. */
  active: boolean
  /** Chosen when the key was made; a different answer takes a new key. */
  scopes: DeviceKeyScope[]
}

export async function listDeviceKeys(): Promise<DeviceKey[]> {
  const { keys } = await fetchConnect<{ keys: DeviceKey[] }>('/device-keys')
  return keys
}

/** The one response that carries the key itself. */
export function createDeviceKey(
  label: string,
  scopes: DeviceKeyScope[],
): Promise<DeviceKey & { key: string }> {
  return fetchConnect('/device-keys', {
    method: 'POST',
    body: { label, scopes },
  })
}

export function revokeDeviceKey(id: string): Promise<unknown> {
  return fetchConnect(`/device-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
