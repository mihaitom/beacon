import { fetchConnect } from './http'
import { mapSong } from '@/services/subsonic/mappers'
import type { RawSong } from '@/services/subsonic/types'
import type { Song } from '@/types/library'

/** An app of the user's own that brings songs the library does not have
 * (connect/core/external_source.py, docs/plans/external-source.md). Beacon
 * shows its page in a tab and plays what the page hands over. There can be
 * several, each with a tab of its own. */
export interface ExternalSource {
  id: string
  name: string
  /** An `mdi-` icon name, one of EXTERNAL_SOURCE_ICONS when set here. */
  icon: string
  /** The page, relative to connect's root. Carries its own credential,
   * since the sandboxed page cannot send the connect token. */
  ui_path: string
  /** Only for a session that may configure it. */
  base_url?: string
  has_token?: boolean
}

export interface ExternalSources {
  /** Whether this session may change them: an admin on a server, anyone
   * on the desktop app. */
  may_configure: boolean
  sources: ExternalSource[]
}

export interface ExternalSourceProbe {
  ok: boolean
  error?: string
  name?: string
  version?: string
  capabilities?: string[]
}

export interface ExternalSourceSettings {
  name: string
  icon: string
  base_url: string
  /** Leave out to keep the stored token. */
  token?: string
}

export type ExternalSourceSaved = ExternalSources & {
  source: ExternalSource
  probe: ExternalSourceProbe
}

/** What a tab may wear: things that sound like music or like a place music
 * comes from, and none of them a brand. */
export const EXTERNAL_SOURCE_ICONS = [
  'mdi-web',
  'mdi-earth',
  'mdi-cloud-outline',
  'mdi-server',
  'mdi-folder-music',
  'mdi-inbox-arrow-down',
  'mdi-album',
  'mdi-music-box-multiple',
  'mdi-playlist-music',
  'mdi-headphones',
  'mdi-record-player',
  'mdi-cassette',
  'mdi-microphone-variant',
  'mdi-guitar-electric',
  'mdi-piano',
  'mdi-gift-outline',
  'mdi-star-outline',
  'mdi-heart-outline',
] as const

export const DEFAULT_EXTERNAL_SOURCE_ICON = 'mdi-web'

/** What the page sends with `beacon.play`. URLs are relative to the app's
 * `ui/` folder, or absolute on the app's own address. */
export interface ExternalItem {
  audioUrl: string
  title?: string
  artist?: string
  album?: string
  coverUrl?: string
  duration?: number
}

const EXTERNAL_ID_PREFIX = 'ext:'

export function isExternalSourceSong(song: Pick<Song, 'id'> | null | undefined): boolean {
  return !!song && song.id.startsWith(EXTERNAL_ID_PREFIX)
}

export async function getExternalSources(): Promise<ExternalSources> {
  return await fetchConnect<ExternalSources>('/external-source')
}

export async function addExternalSource(
  settings: ExternalSourceSettings,
): Promise<ExternalSourceSaved> {
  return await fetchConnect('/external-source', { method: 'POST', body: settings })
}

export async function changeExternalSource(
  id: string,
  settings: ExternalSourceSettings,
): Promise<ExternalSourceSaved> {
  return await fetchConnect(`/external-source/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: settings,
  })
}

export async function removeExternalSource(id: string): Promise<ExternalSources> {
  return await fetchConnect<ExternalSources>(`/external-source/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function probeExternalSource(id: string): Promise<ExternalSourceProbe> {
  return await fetchConnect<ExternalSourceProbe>(`/external-source/${encodeURIComponent(id)}/probe`)
}

export async function registerExternalItem(sourceId: string, item: ExternalItem): Promise<Song> {
  const { song } = await fetchConnect<{ song: RawSong }>(
    `/external-source/${encodeURIComponent(sourceId)}/items`,
    { method: 'POST', body: item },
  )
  return mapSong(song)
}

/** The page's `beacon.play` message, checked field by field: it comes from
 * code Beacon does not control. Null for anything else. */
export function parsePlayMessage(
  data: unknown,
): { mode: 'now' | 'next' | 'queue'; item: ExternalItem } | null {
  if (data === null || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.type !== 'beacon.play') return null
  const mode = message.mode === 'next' || message.mode === 'queue' ? message.mode : 'now'
  const raw = message.item
  if (raw === null || typeof raw !== 'object') return null
  const fields = raw as Record<string, unknown>
  if (typeof fields.audioUrl !== 'string' || !fields.audioUrl) return null
  const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 500) : undefined)
  const duration = Number(fields.duration)
  return {
    mode,
    item: {
      audioUrl: fields.audioUrl.slice(0, 2000),
      title: text(fields.title),
      artist: text(fields.artist),
      album: text(fields.album),
      coverUrl: text(fields.coverUrl),
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    },
  }
}

const GUIDE_URL =
  'https://raw.githubusercontent.com/mihaitom/beacon/main/docs/help/reference/external-source-api.md'
const EXAMPLES_URL = 'https://github.com/mihaitom/beacon/tree/main/docs/examples'

/** Text to paste into an AI assistant, complete in itself: the contract is
 * short enough to give whole, and the guide it links to may not be online
 * yet for a build that is newer than the last release. */
export function externalSourceInstructions(): string {
  return [
    'Help me write a small web app that works as an "external source" for my Beacon music player.',
    'Beacon shows a page from my app in a tab and plays songs the page hands to it, on my speakers too.',
    `Full description: ${GUIDE_URL}`,
    `Complete working examples (Python), one for local files and one for an online source: ${EXAMPLES_URL}`,
    '',
    'What my app must serve (all under one base URL, e.g. http://192.168.1.20:8800):',
    '- GET /v1 -> JSON {"name": "...", "version": "...", "capabilities": []}. Beacon calls it to check the connection.',
    '- Everything under /ui/: the page for the tab (GET /ui/ returns the HTML), its scripts and styles, and any API the page itself needs, e.g. /ui/api/search.',
    '- The audio files, at URLs under the same base URL.',
    '',
    'How the page runs:',
    '- Beacon passes /ui/ through its own server, so use only RELATIVE URLs in the page ("app.js", "api/search?q=x"), never absolute ones and never a leading slash.',
    '- Everything the page loads itself (scripts, styles, images such as covers it displays, its API) must live under /ui/: "../" leads out of what Beacon passes through.',
    '- The page runs in a sandboxed iframe with an opaque origin: no cookies, no localStorage, no sessionStorage, no navigating the top window. Keep state in memory or in the app.',
    '- The token is optional and my app defines it (e.g. from an environment variable); I enter the same value in Beacon. It is not a key from Beacon\'s "Apps and devices", which is for apps calling Beacon. If set, every request Beacon forwards to /v1 and /ui/ carries "Authorization: Bearer <token>". Audio and cover URLs get no header: make them unguessable or sign them, and keep them valid for at least a day.',
    "- It must work on a phone too, where it gets only the space between Beacon's bars (phone width, often ~600px high): give narrow widths (@media (max-width: 640px)) a dense layout of their own with smaller type, a compact header without the app's name (Beacon shows it), and covers beside titles rather than above them.",
    '',
    'How the page plays a song:',
    '- window.parent.postMessage({type: "beacon.play", mode: "now" | "next" | "queue", item: {audioUrl, title, artist, album, coverUrl, duration}}, "*")',
    '- audioUrl and coverUrl: relative to /ui/ (e.g. "../audio/123.m4a" or "/audio/123.m4a") or absolute on the app\'s own address. Anything else is refused.',
    '- duration in seconds. Everything except audioUrl is optional but makes the player look right.',
    '- Serve audio with Content-Length and support HTTP Range requests: then seeking, waveforms and transitions work. Common formats (mp3, m4a/aac, webm/opus, ogg, flac) all play.',
    '- Keep audio URLs working for at least a day, so a queue restored later still plays.',
    '',
    'Messages Beacon sends to the page (listen with window.addEventListener("message", ...)):',
    '- {type: "beacon.theme", dark: boolean, colors: {background, surface, text, primary, ...}} after the page sends {type: "beacon.ready"}, and again on a theme change. Use the colours to match Beacon\'s look.',
    '- {type: "beacon.nowPlaying", item: {title, artist, album} | null} when the song changes.',
    '- {type: "beacon.played", ok: boolean, error?: string} after each beacon.play.',
    '',
    'Please write the app in <language of your choice>, with the page as plain HTML/CSS/JS without a build step.',
  ].join('\n')
}
