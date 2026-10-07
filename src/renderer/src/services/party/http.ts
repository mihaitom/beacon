import { fetchConnect } from '../connect/http'

export interface PartyGuest {
  guest_id: string
  name: string
  joined_at: number
  connected: boolean
}

export interface PartyStatus {
  enabled: boolean
  expires_at: number | null
  lan_ip: string
  port: number
  guests: PartyGuest[]
  max_pending_per_guest: number
  skip_ratio: number
  /** Listening along: the guests' AAC bitrate, 0 while it is off. */
  listen_kbps: number
  /** Guests listening along right now. */
  listeners: number
  /** Which window answers guests - see stores/party.ts's tabId(). */
  host_tab: string | null
}

/** Only /enable, /rotate and /claim carry the invite token - /status never
 * does, the same rule the phone remote's password follows. */
export interface PartyInvite extends PartyStatus {
  token: string
}

export interface PartySettings {
  max_pending_per_guest: number
  skip_ratio: number
  listen_kbps: number
}

/** The host side of party mode (connect's /party-host/*, CONNECT_TOKEN).
 * Nothing here is reachable under /party/, which is what guests get. */

export function enableParty(
  body: PartySettings & { duration_hours: number; tab_id: string },
): Promise<PartyInvite> {
  return fetchConnect<PartyInvite>('/party-host/enable', { method: 'POST', body })
}

export function rotatePartyLink(): Promise<PartyInvite> {
  return fetchConnect<PartyInvite>('/party-host/rotate', { method: 'POST' })
}

export function disableParty(): Promise<{ success: boolean }> {
  return fetchConnect<{ success: boolean }>('/party-host/disable', { method: 'POST' })
}

/** Makes the window `tabId` the one answering guests, with the link it
 * goes on showing them. */
export function claimPartyHost(tabId: string): Promise<PartyInvite> {
  return fetchConnect<PartyInvite>('/party-host/claim', { method: 'POST', body: { tab_id: tabId } })
}

export function getPartyStatus(): Promise<PartyStatus> {
  return fetchConnect<PartyStatus>('/party-host/status')
}

export function updatePartySettings(body: PartySettings): Promise<PartyStatus> {
  return fetchConnect<PartyStatus>('/party-host/settings', { method: 'POST', body })
}

export function kickPartyGuest(guestId: string): Promise<PartyStatus> {
  return fetchConnect<PartyStatus>(`/party-host/guests/${encodeURIComponent(guestId)}`, {
    method: 'DELETE',
  })
}

export interface PartyLyrics {
  song_id: string
  synced: boolean
  offset: number
  lines: { time: number; text: string }[]
}

/** The playing song's lyrics as this window has them, for guests. */
export function pushPartyLyrics(body: PartyLyrics): Promise<{ success: boolean }> {
  return fetchConnect<{ success: boolean }>('/party-host/lyrics', { method: 'POST', body })
}
