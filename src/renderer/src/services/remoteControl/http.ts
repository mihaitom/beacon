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
  /** Phones holding an open event stream right now. Read at startup so the
   * button is right straight away; after that the agent stream keeps it
   * up to date (see stores/remoteControl.ts). */
  phone_count: number
  /** Whether an integration key exists — the relay then runs whether or not
   * phones are switched on (see stores/remoteControl.ts). */
  integration: boolean
}

export interface IntegrationKeyResponse {
  key: string
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

/** Creates the key home automation uses, replacing any earlier one. The
 * response is the only place it is ever sent. */
export function generateIntegrationKey(): Promise<IntegrationKeyResponse> {
  return fetchConnect<IntegrationKeyResponse>('/remote/integration-key', { method: 'POST' })
}

export function revokeIntegrationKey(): Promise<{ success: boolean }> {
  return fetchConnect<{ success: boolean }>('/remote/integration-key', { method: 'DELETE' })
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

/** Acks a phone-issued command relayed via agent.ts's onCommand(), once
 * handleRemoteCommand() has actually applied it — POST /remote/command
 * (routes/remote.py) blocks on this the same way a query blocks on
 * respondToRemoteQuery() above; it's the identical relay; this is just a
 * name at the call site that says what's actually being answered. */
export function respondToRemoteCommand(
  requestId: string,
  data: { error: string } | { success: true },
): Promise<void> {
  return fetchConnect<void>('/remote/query-response', {
    method: 'POST',
    body: { request_id: requestId, data },
  })
}
