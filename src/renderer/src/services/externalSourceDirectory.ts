import { GITHUB_REPO } from './project'
import { DEFAULT_EXTERNAL_SOURCE_ICON, EXTERNAL_SOURCE_ICONS } from './connect/externalSource'

/** An external source someone else wrote and listed in
 * `community/external-sources.json` - not part of Beacon and not checked by
 * it (community/README.md). */
export interface DirectoryApp {
  name: string
  description: string
  /** Its public repository, always `https://`. */
  repository: string
  /** One of EXTERNAL_SOURCE_ICONS, suggested for the tab. */
  icon: string
}

/** The branch the list is read from. main for a release: an entry is
 * listed once its pull request is merged there, whichever version of
 * Beacon reads it.
 *
 * TODO(before release): back to 'main'. development only while the list
 * is not on main yet - the publish workflows refuse to build until it is
 * (_ensure-release.yml, _publish-docker.yml). */
export const DIRECTORY_BRANCH = 'development'

export const DIRECTORY_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${DIRECTORY_BRANCH}/community/external-sources.json`

export const MAX_NAME_LENGTH = 60
export const MAX_DESCRIPTION_LENGTH = 300
/** Far more than the list will hold for a long time; it only keeps a
 * broken or hostile file from filling the dialog. */
export const MAX_APPS = 500

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

function repository(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    // Opened in the browser from the dialog: nothing but a web page.
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/** One entry, or null when any field is not what community/README.md
 * asks for. */
export function parseDirectoryApp(raw: unknown): DirectoryApp | null {
  if (raw === null || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const name = text(entry.name, MAX_NAME_LENGTH)
  const description = text(entry.description, MAX_DESCRIPTION_LENGTH)
  const repo = repository(entry.repository)
  if (!name || !description || !repo) return null
  if (
    entry.icon !== undefined &&
    !(EXTERNAL_SOURCE_ICONS as readonly unknown[]).includes(entry.icon)
  ) {
    return null
  }
  return {
    name,
    description,
    repository: repo,
    icon: (entry.icon as string) ?? DEFAULT_EXTERNAL_SOURCE_ICON,
  }
}

/** The file as Beacon reads it: entries that do not fit are left out
 * rather than failing the whole list, one per repository, by name. The
 * file is fetched from the web, so nothing in it is trusted. */
export function parseDirectory(data: unknown): DirectoryApp[] {
  if (data === null || typeof data !== 'object') return []
  const raw = (data as Record<string, unknown>).apps
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const apps: DirectoryApp[] = []
  for (const entry of raw.slice(0, MAX_APPS)) {
    const app = parseDirectoryApp(entry)
    const key = app?.repository.toLowerCase().replace(/\/+$/, '')
    if (!app || !key || seen.has(key)) continue
    seen.add(key)
    apps.push(app)
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** The list as it is on main right now. Asked for each time the dialog
 * opens: it is small, and a cached copy would hide a new entry. */
export async function fetchDirectory(): Promise<DirectoryApp[]> {
  const response = await fetch(DIRECTORY_URL, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseDirectory(await response.json())
}

/** The repository's address without its scheme ("github.com/owner/name"),
 * which a row shows under the description: enough to see whose it is. */
export function repositoryLabel(url: string): string {
  const parsed = new URL(url)
  return `${parsed.host.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`
}
