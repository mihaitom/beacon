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
  /** Who made it: a GitHub login, credited with avatar and profile link
   * like the release notes do. */
  author: string
  /** One of EXTERNAL_SOURCE_ICONS: what the card shows without an image,
   * or when the image does not load. */
  icon: string
  /** A `.webp` from the app's own repository, shown instead of the icon. */
  image: string | null
}

/** The branch the list is read from: an entry is listed once its pull
 * request is merged to main, whichever version of Beacon reads it. */
export const DIRECTORY_BRANCH = 'main'

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

// GitHub's own rule: letters, digits and single hyphens, 39 at most.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

function login(value: unknown): string | null {
  return typeof value === 'string' && LOGIN.test(value) ? value : null
}

/** The only hosts a listed repository may live on, each with the hosts
 * its files - a picture - may come from. Opening the list makes Beacon
 * load those pictures, so nobody's own server learns who opened it. */
export const REPOSITORY_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'github.com': ['github.com', 'raw.githubusercontent.com'],
  'codeberg.org': ['codeberg.org'],
  'gitlab.com': ['gitlab.com'],
}

function repository(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  // Opened in the browser from the dialog: nothing but a web page.
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (!Object.hasOwn(REPOSITORY_HOSTS, url.hostname)) return null
  // An owner and a name at least: a host's front page is no repository.
  return url.pathname.split('/').filter(Boolean).length >= 2 ? url.href : null
}

/** The repository itself, "owner/name", from an address that may point
 * into a folder of it (`.../tree/main/docs/x`). On GitLab a project can sit
 * in nested groups, so there it is everything before the `/-/` that starts
 * GitLab's own pages. */
export function repositoryPath(repo: string): string | null {
  const url = new URL(repo)
  const segments = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'gitlab.com') {
    const end = segments.indexOf('-')
    const project = end < 0 ? segments : segments.slice(0, end)
    return project.length >= 2 ? project.join('/') : null
  }
  const [owner, name] = segments
  return owner && name ? `${owner}/${name}` : null
}

/** Where a repository's own files are served from: the hosts
 * REPOSITORY_HOSTS gives its host, under its own path. */
function repositoryRoot(repo: string): { hosts: string[]; path: string } | null {
  const path = repositoryPath(repo)
  const hosts = REPOSITORY_HOSTS[new URL(repo).hostname]
  if (!path || !hosts) return null
  return { hosts: [...hosts], path: `/${path}/`.toLowerCase() }
}

/** An image address from the entry, or null unless it is a plain https
 * `.webp` inside the app's own repository - the list never makes Beacon
 * load anything from anywhere else. A GitHub `blob` page address becomes
 * the file itself, which is what an author copying it from the browser
 * would mean. */
function image(value: unknown, repo: string): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null
  }
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/')
    if (parts[3] === 'blob') {
      url = new URL(
        `https://raw.githubusercontent.com/${[parts[1], parts[2], ...parts.slice(4)].join('/')}`,
      )
    }
  }
  if (!url.pathname.toLowerCase().endsWith('.webp')) return null
  const root = repositoryRoot(repo)
  if (!root || !root.hosts.includes(url.hostname)) return null
  return url.pathname.toLowerCase().startsWith(root.path) ? url.href : null
}

function isIconName(value: unknown): boolean {
  return (EXTERNAL_SOURCE_ICONS as readonly unknown[]).includes(value)
}

/** One entry, or null when any field is not what community/README.md
 * asks for. */
export function parseDirectoryApp(raw: unknown): DirectoryApp | null {
  if (raw === null || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const name = text(entry.name, MAX_NAME_LENGTH)
  const description = text(entry.description, MAX_DESCRIPTION_LENGTH)
  const repo = repository(entry.repository)
  const author = login(entry.author)
  if (!name || !description || !repo || !author) return null
  // An icon name, an image from the repository, or nothing at all.
  let icon = DEFAULT_EXTERNAL_SOURCE_ICON
  let picture: string | null = null
  if (isIconName(entry.icon)) {
    icon = entry.icon as string
  } else if (entry.icon !== undefined) {
    picture = image(entry.icon, repo)
    if (!picture) return null
  }
  return { name, description, repository: repo, author, icon, image: picture }
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

/** The author's GitHub avatar, as the release notes show it. */
export function avatarUrl(author: string): string {
  return `https://github.com/${author}.png?size=64`
}

/** The repository's address without its scheme ("github.com/owner/name"),
 * which a row shows under the description: enough to see whose it is. */
export function repositoryLabel(url: string): string {
  const parsed = new URL(url)
  return `${parsed.host.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`
}

/** How long a repository's stars are kept before they are asked for
 * again. GitHub answers 60 unauthenticated questions an hour per address;
 * a list opened now and then must never come near that. */
export const STARS_TTL_MS = 6 * 60 * 60 * 1000
/** How long the dialog waits for the stars before it shows the list
 * without them, sorted by name. */
export const STARS_TIMEOUT_MS = 4000
const STARS_KEY = 'beacon.communityStars'

/** The host's own API for a repository's details, or null for an address
 * it cannot be read from. */
export function starsApiUrl(repo: string): string | null {
  const path = repositoryPath(repo)
  if (!path) return null
  switch (new URL(repo).hostname) {
    case 'github.com':
      return `https://api.github.com/repos/${path}`
    case 'codeberg.org':
      return `https://codeberg.org/api/v1/repos/${path}`
    case 'gitlab.com':
      return `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`
    default:
      return null
  }
}

/** The star count in a host's answer: each names it differently. */
export function readStars(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null
  const answer = data as Record<string, unknown>
  for (const field of ['stargazers_count', 'stars_count', 'star_count']) {
    const value = answer[field]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  }
  return null
}

type StarCache = Record<string, { stars: number; at: number }>

// Only ever a convenience: without storage the stars are just asked for
// again.
function readCache(): StarCache {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STARS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as StarCache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: StarCache): void {
  try {
    localStorage.setItem(STARS_KEY, JSON.stringify(cache))
  } catch {
    // Full or blocked: the next open asks again.
  }
}

/** One repository's stars, from the cache while it is fresh, otherwise
 * from its host. Null when the host would not say. */
export async function fetchStars(
  repo: string,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<number | null> {
  const cached = readCache()[repo]
  if (cached && now - cached.at < STARS_TTL_MS) return cached.stars
  const url = starsApiUrl(repo)
  if (!url) return null
  let stars: number | null
  try {
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    stars = response.ok ? readStars(await response.json()) : null
  } catch {
    stars = null
  }
  // An old count beats none: a rate limit or a timeout is not news.
  if (stars === null) return cached?.stars ?? null
  writeCache({ ...readCache(), [repo]: { stars, at: now } })
  return stars
}

/** Every app's stars at once, given STARS_TIMEOUT_MS in all; an app whose
 * host did not answer in time, or at all, has none. */
export async function fetchAllStars(apps: DirectoryApp[]): Promise<Map<string, number>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STARS_TIMEOUT_MS)
  try {
    const results = await Promise.allSettled(
      apps.map((app) => fetchStars(app.repository, controller.signal)),
    )
    const stars = new Map<string, number>()
    results.forEach((result, n) => {
      if (result.status === 'fulfilled' && result.value !== null) {
        stars.set(apps[n]!.repository, result.value)
      }
    })
    return stars
  } finally {
    clearTimeout(timer)
  }
}

/** Most stars first; those without any count, and ties, by name. */
export function sortByStars(apps: DirectoryApp[], stars: Map<string, number>): DirectoryApp[] {
  return [...apps].sort(
    (a, b) =>
      (stars.get(b.repository) ?? -1) - (stars.get(a.repository) ?? -1) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}
