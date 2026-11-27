import { watch } from 'vue'
import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { pollingAllowed } from '@/services/connect/pollGate'

/**
 * Notices when the web app in this tab is older than the one deployed, and
 * offers a reload. Beacon stays open for days, and after a container update
 * an open tab keeps running the old code - until it tries to load a page
 * whose old, hashed file is no longer on the server.
 *
 * Compares build ids, not versions (see vite.build-id.ts), so a rebuild
 * without a version bump counts too. Never reloads by itself: that would
 * cut into whatever is playing.
 */

// Matches vite.build-id.ts. Not imported from there: that file is Node.
const BUILD_ID_META = 'beacon-build'
const BUILD_ID_FILE = 'build.json'

const CHECK_INTERVAL_MS = 30 * 60_000
// Switching tabs back and forth should not ask the server every time.
const MIN_GAP_MS = 60_000

export interface BuildCheckDeps {
  ownId: string
  fetchDeployedId: () => Promise<string | null>
  announce: () => void
  now?: () => number
}

export interface BuildCheck {
  /** `force` skips the minimum gap - for a check with a concrete reason,
   * like a page that just failed to load. */
  check: (force?: boolean) => Promise<void>
}

export function createBuildCheck(deps: BuildCheckDeps): BuildCheck {
  const now = deps.now ?? Date.now
  let lastCheck = -Infinity
  let inFlight = false
  // Once per deployed build: a dismissed hint stays dismissed until there
  // is yet another build to tell about.
  let announcedFor: string | null = null

  return {
    async check(force = false) {
      if (inFlight) return
      if (!force && now() - lastCheck < MIN_GAP_MS) return
      inFlight = true
      lastCheck = now()
      try {
        const deployed = await deps.fetchDeployedId()
        if (!deployed || deployed === deps.ownId) return
        // A forced check means something already broke - worth saying again.
        if (deployed === announcedFor && !force) return
        announcedFor = deployed
        deps.announce()
      } finally {
        inFlight = false
      }
    },
  }
}

async function fetchDeployedId(): Promise<string | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${BUILD_ID_FILE}`, {
      cache: 'no-store',
    })
    if (!response.ok) return null
    const body = (await response.json()) as { id?: unknown }
    return typeof body.id === 'string' ? body.id : null
  } catch {
    // Offline or mid-restart: nothing to conclude, the next check will tell.
    return null
  }
}

function announce(): void {
  emitter.emit('toast', {
    level: 'information',
    title: i18n.global.t('buildCheck.title'),
    message: i18n.global.t('buildCheck.message'),
    action: { label: i18n.global.t('buildCheck.reload'), onClick: () => window.location.reload() },
    sticky: true,
  })
}

/** Only the web build carries a build id. The desktop app updates through
 * its own updater, and a dev server has no build to compare. */
export function initBuildCheck(): void {
  const ownId = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_ID_META}"]`)?.content
  if (!ownId) return

  const buildCheck = createBuildCheck({ ownId, fetchDeployedId, announce })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void buildCheck.check()
  })
  setInterval(() => {
    if (pollingAllowed()) void buildCheck.check()
  }, CHECK_INTERVAL_MS)
  // A container update restarts connect, so the event stream coming back
  // is the earliest moment a new build can be there.
  watch(
    () => useConnectStore().connected,
    (connected) => {
      if (connected) void buildCheck.check()
    },
  )
  // A lazily loaded page whose file is gone. Only worth a hint if a new
  // build really is the reason - a dropped connection fails the same way.
  window.addEventListener('vite:preloadError', () => void buildCheck.check(true))
}
