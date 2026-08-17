import { fetchConnect } from '../connect/http'

export interface RemoteControlCredentials {
  password: string
  pin: string
  lan_ip: string
  port: number
}

export interface RemoteControlStatus {
  enabled: boolean
  pin: string | null
  lan_ip: string
  port: number
}

/** Thin wrappers over the connect backend's /remote/* control plane — all
 * of these carry X-Connect-Token (via fetchConnect), the same
 * machine-to-machine credential the renderer already uses for casting.
 * The actual phone-facing password lives entirely in RemoteControlCredentials
 * below; nothing here ever sends it anywhere. */

export function enableRemoteControl(): Promise<RemoteControlCredentials> {
  return fetchConnect<RemoteControlCredentials>('/remote/enable', { method: 'POST' })
}

export function disableRemoteControl(): Promise<{ success: boolean }> {
  return fetchConnect<{ success: boolean }>('/remote/disable', { method: 'POST' })
}

export function getRemoteControlStatus(): Promise<RemoteControlStatus> {
  return fetchConnect<RemoteControlStatus>('/remote/status')
}

export function sendRemoteKeepalive(): Promise<void> {
  return fetchConnect<void>('/remote/keepalive', { method: 'POST' })
}

/** Pushes the renderer's current playback snapshot so connect can serve it
 * to phones (GET /remote/state) and broadcast it over GET /remote/events. */
export function pushRemoteState(snapshot: Record<string, unknown>): Promise<void> {
  return fetchConnect<void>('/remote/state', { method: 'POST', body: { snapshot } })
}

/** Answers a phone-issued data query relayed via agent.ts's onQuery(). */
export function respondToRemoteQuery(requestId: string, data: unknown): Promise<void> {
  return fetchConnect<void>('/remote/query-response', {
    method: 'POST',
    body: { request_id: requestId, data },
  })
}
