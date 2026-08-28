import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { isMobileWebNow } from '@/composables/useIsMobileWeb'

// Every view the tests below actually navigate into — the guard runs before
// Vue Router resolves these, but the resolution still happens afterwards,
// and pulling the real views (and all of Vuetify with them) in would test
// nothing about the guard.
const stub = { default: { template: '<div />' } }
vi.mock('../../views/ServerLoginView.vue', () => stub)
vi.mock('../../views/HomeView.vue', () => stub)
vi.mock('../../views/FavoritesView.vue', () => stub)
vi.mock('../../views/mobile/MobileNowPlayingView.vue', () => stub)

vi.mock('@/composables/useIsMobileWeb', () => ({ isMobileWebNow: vi.fn(() => false) }))
vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn(() => ({ stop: vi.fn() })) }))

/** The guard keeps one in-flight restore in module state, so each test
 * starts from a router module that has never run one. */
async function freshRouter(): Promise<typeof import('../index').default> {
  vi.resetModules()
  const mod = await import('../index')
  return mod.default
}

describe('the router auth guard', () => {
  beforeEach(() => {
    // jsdom implements no scrolling, and the router's scrollBehavior runs
    // on every one of these navigations.
    vi.stubGlobal('scrollTo', vi.fn())
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(isMobileWebNow).mockReturnValue(false)
  })

  it('sends an unauthenticated visitor to the login screen, remembering where they wanted to go', async () => {
    const router = await freshRouter()
    vi.spyOn(useAuthStore(), 'restore').mockResolvedValue(false)

    await router.push('/favorites')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/favorites')
  })

  it('lets them straight through once a silent restore succeeds', async () => {
    const router = await freshRouter()
    const auth = useAuthStore()
    vi.spyOn(auth, 'restore').mockImplementation(async () => {
      auth.authenticated = true
      return true
    })

    await router.push('/favorites')

    expect(router.currentRoute.value.name).toBe('favorites')
  })

  it('never blocks the login screen itself, and does not try to restore for it', async () => {
    const router = await freshRouter()
    const restore = vi.spyOn(useAuthStore(), 'restore').mockResolvedValue(false)

    await router.push('/login')

    expect(router.currentRoute.value.name).toBe('login')
    expect(restore).not.toHaveBeenCalled()
  })

  it('keeps a signed-in listener away from a page their server cannot answer', async () => {
    // Favorites has no backing call on Plex, so the route would only ever
    // lead to a dead end there.
    const router = await freshRouter()
    const auth = useAuthStore()
    auth.authenticated = true
    auth.serverType = 'plex'

    await router.push('/favorites')

    expect(auth.capabilities.favorites).toBe(false)
    expect(router.currentRoute.value.name).toBe('home')
  })

  it('lands mobile web on its own shell rather than the desktop home page', async () => {
    const router = await freshRouter()
    useAuthStore().authenticated = true
    vi.mocked(isMobileWebNow).mockReturnValue(true)

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('m-now-playing')
  })
})
