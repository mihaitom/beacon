import { fetchConnect } from './http'

/** Every external service whose key Beacon stores for the whole
 * installation (connect/core/api_keys.py's registry). The Settings section
 * renders one row per entry, so a new keyed service is added here and
 * there, not as another route. */
export type ApiKeyService = 'lastfm' | 'fanart'

export interface ApiKeyStatus {
  /** Whether this installation has a key at all. */
  configured: boolean
  /** The key came from the deployment's environment rather than from
   * Settings, so the field is empty although a key is in effect. The key
   * itself never leaves the backend. */
  fromEnvironment: boolean
}

export type ApiKeyStatuses = Record<ApiKeyService, ApiKeyStatus>

export async function getApiKeyStatuses(): Promise<ApiKeyStatuses> {
  const data = await fetchConnect<{ keys: ApiKeyStatuses }>('/api-keys')
  return data.keys
}

/** Stores a key for the whole installation, or clears it with `''` — which
 * falls back to the service's environment variable where one is set.
 * Returns every service's status, since storing one never changes another
 * but the caller would otherwise have to merge. */
export async function setApiKey(service: ApiKeyService, key: string): Promise<ApiKeyStatuses> {
  const data = await fetchConnect<{ keys: ApiKeyStatuses }>(`/api-keys/${service}`, {
    method: 'POST',
    body: { key },
  })
  return data.keys
}
