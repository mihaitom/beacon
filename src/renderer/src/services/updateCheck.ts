import packageJson from '../../../../package.json'

// Matches electron-builder.yml's own `publish` block — not a second,
// independently-maintained source of truth for where releases live.
const GITHUB_REPO = 'mihaitom/beacon'

export interface UpdateCheckResult {
  available: boolean
  latestVersion: string | null
  releaseUrl: string | null
}

const NONE: UpdateCheckResult = { available: false, latestVersion: null, releaseUrl: null }

/** Compares two `MAJOR.MINOR[.PATCH...]` version strings — true if `latest`
 * is newer than `current`. Plain numeric segment comparison (no pre-release/
 * build-metadata handling) is enough here: package.json's own version field
 * never carries either. */
function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Checks this repo's GitHub Releases for a version newer than the one
 * currently running — the only update-notification path available to the
 * Docker/web build at all (no electron-updater there to auto-download and
 * native-prompt the way Electron's own checkForUpdates() does, see
 * src/main/index.ts). Harmless to also surface in Electron: a quiet,
 * persistent confirmation in Settings that a newer version genuinely
 * exists, in case the native prompt was dismissed or DISABLE_AUTO_UPDATES
 * is set — this never downloads or installs anything itself, purely informational.
 *
 * Fails silently (network error, no releases published yet, rate-limited) —
 * this is a nice-to-have, not core functionality worth surfacing an error
 * for; the caller just gets `available: false`, same as "no update". */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
    if (!response.ok) return NONE
    const data = await response.json()
    const tag = typeof data.tag_name === 'string' ? data.tag_name : null
    if (!tag) return NONE
    const latestVersion = tag.replace(/^v/, '')
    if (!isNewer(latestVersion, packageJson.version)) return NONE
    return {
      available: true,
      latestVersion,
      releaseUrl: typeof data.html_url === 'string' ? data.html_url : null,
    }
  } catch {
    return NONE
  }
}
