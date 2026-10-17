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
vi.mock('../../views/mobile/MobileFavoritesView.vue', () => stub)
vi.mock('../../views/PlaylistsView.vue', () => stub)
vi.mock('../../views/PlaylistDetailView.vue', () => stub)
vi.mock('../../views/SmartPlaylistEditorView.vue', () => stub)

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

  it('keeps the phone shell off the favourites tab on such a server too', async () => {
    const router = await freshRouter()
    const auth = useAuthStore()
    auth.authenticated = true
    auth.serverType = 'plex'

    await router.push('/m/favorites')

    expect(router.currentRoute.value.name).not.toBe('m-favorites')
  })

  describe('the smart playlist editor', () => {
    function signIn(serverSoftware: string) {
      const auth = useAuthStore()
      auth.authenticated = true
      auth.serverType = 'subsonic'
      auth.health = {
        ffmpeg: true,
        navidrome_configured: true,
        server_lock: null,
        session_server_type: 'subsonic',
        session_server_software: serverSoftware,
      }
    }

    it('opens on Navidrome', async () => {
      const router = await freshRouter()
      signIn('navidrome')

      await router.push('/playlists/smart/new')

      expect(router.currentRoute.value.name).toBe('smart-playlist-new')
    })

    it('sends a new one back to the playlists on any other server', async () => {
      const router = await freshRouter()
      signIn('gonic')

      await router.push('/playlists/smart/new')

      expect(router.currentRoute.value.name).toBe('playlists')
    })

    it('sends "edit rules" back to the playlist it was for', async () => {
      const router = await freshRouter()
      signIn('')

      await router.push('/playlists/pl1/rules')

      expect(router.currentRoute.value.fullPath).toBe('/playlists/pl1')
    })

    it('waits for a silent restore to say what the server is before deciding', async () => {
      // A reload straight onto the editor: nothing is known until restore()
      // has asked connect, and that answer has to be the one that counts.
      const router = await freshRouter()
      const auth = useAuthStore()
      vi.spyOn(auth, 'restore').mockImplementation(async () => {
        signIn('navidrome')
        return true
      })

      await router.push('/playlists/smart/new')

      expect(router.currentRoute.value.name).toBe('smart-playlist-new')
    })
  })

  it('lands mobile web on its own shell rather than the desktop home page', async () => {
    const router = await freshRouter()
    useAuthStore().authenticated = true
    vi.mocked(isMobileWebNow).mockReturnValue(true)

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('m-now-playing')
  })
})
