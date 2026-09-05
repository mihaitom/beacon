import { createRouter, createWebHashHistory } from 'vue-router'
import { nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { isMobileWebNow } from '@/composables/useIsMobileWeb'

declare module 'vue-router' {
  interface RouteMeta {
    layout?: 'auth' | 'default'
  }
}

// Per-route scroll memory, keyed by path (not fullPath — a route's scroll
// state shouldn't depend on which query params it happened to carry this
// time). Vue Router's own scrollBehavior `savedPosition` argument is only
// ever populated for real browser back/forward navigation — a plain
// router.push() (every in-app navigation here, including MobileTabBar.vue's
// tab switches) always gets `null` there, so without this a tab switch just
// left the window at whatever scroll position the *previous* tab happened
// to be at instead of either starting fresh or restoring its own.
const scrollPositions = new Map<string, number>()

const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior(to) {
    // Waits a tick for the new route's component to actually be in the DOM
    // — scrolling immediately can land on the *previous* page's content
    // still being there, especially once the new page's real height (often
    // taller/shorter than the last) is what should decide whether the
    // saved offset is even reachable.
    return new Promise((resolve) => {
      void nextTick(() => resolve({ top: scrollPositions.get(to.path) ?? 0 }))
    })
  },
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/ServerLoginView.vue'),
      meta: { layout: 'auth' },
    },
    {
      path: '/',
      name: 'home',
      component: () => import('../views/HomeView.vue'),
    },
    {
      path: '/albums',
      name: 'albums',
      component: () => import('../views/AlbumsView.vue'),
    },
    {
      path: '/albums/:id',
      name: 'album-detail',
      component: () => import('../views/AlbumDetailView.vue'),
    },
    {
      path: '/artists',
      name: 'artists',
      component: () => import('../views/ArtistsView.vue'),
    },
    {
      path: '/artists/:id',
      name: 'artist-detail',
      component: () => import('../views/ArtistDetailView.vue'),
    },
    {
      path: '/genres',
      name: 'genres',
      component: () => import('../views/GenresView.vue'),
    },
    {
      path: '/genres/:name',
      name: 'genre-detail',
      component: () => import('../views/GenreDetailView.vue'),
    },
    {
      path: '/songs',
      name: 'songs',
      component: () => import('../views/SongsView.vue'),
    },
    {
      path: '/playlists',
      name: 'playlists',
      component: () => import('../views/PlaylistsView.vue'),
    },
    {
      path: '/playlists/:id',
      name: 'playlist-detail',
      component: () => import('../views/PlaylistDetailView.vue'),
    },
    {
      path: '/radio',
      name: 'radio',
      component: () => import('../views/RadioView.vue'),
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('../views/SearchView.vue'),
    },
    {
      path: '/favorites',
      name: 'favorites',
      component: () => import('../views/FavoritesView.vue'),
    },
    {
      path: '/stats',
      name: 'stats',
      component: () => import('../views/StatsView.vue'),
    },
    {
      path: '/now-playing',
      name: 'now-playing',
      component: () => import('../views/NowPlayingView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsView.vue'),
    },
    // Mobile web routes (see composables/useIsMobileWeb.ts) — parallel to the
    // desktop routes above rather than replacing them, so MobileLayout.vue's
    // router-view can pick its own touch-optimized child views without every
    // existing desktop view needing to branch internally. Reachable
    // regardless of viewport/build (a desktop browser can load /m/songs
    // directly), but App.vue's `layout` computed only ever *lands* someone
    // here automatically when isMobileWeb is true — see the 'home' redirect
    // in the guard below.
    {
      path: '/m/now-playing',
      name: 'm-now-playing',
      component: () => import('../views/mobile/MobileNowPlayingView.vue'),
    },
    {
      path: '/m/queue',
      name: 'm-queue',
      component: () => import('../views/mobile/MobileQueueView.vue'),
    },
    {
      path: '/m/playlists',
      name: 'm-playlists',
      component: () => import('../views/mobile/MobilePlaylistsView.vue'),
    },
    {
      path: '/m/playlists/:id',
      name: 'm-playlist-detail',
      component: () => import('../views/mobile/MobilePlaylistDetailView.vue'),
    },
    {
      path: '/m/library',
      name: 'm-library',
      component: () => import('../views/mobile/MobileLibraryView.vue'),
    },
    // The songs list grew an albums half and became the library (see
    // MobileLibraryView.vue), so the old path is kept as a redirect rather
    // than 404ing a bookmark or a link someone already has.
    { path: '/m/songs', redirect: { name: 'm-library' } },
    {
      path: '/m/radio',
      name: 'm-radio',
      component: () => import('../views/mobile/MobileRadioView.vue'),
    },
  ],
})

// Dedupes concurrent restore() attempts (several near-simultaneous
// navigations at boot shouldn't each fire their own restore) without
// permanently disabling retries — a plain "did we ever try" boolean would
// mean any *later* auth loss (e.g. the connect backend briefly restarting
// and a 401 tripping fetchConnect()'s fallback, see services/connect/
// http.ts) leaves the user stuck on /login until a full app restart, since
// nothing would ever attempt restore() again for the rest of the session.
// Clearing this once the in-flight attempt settles means the very next
// navigation gets a fresh try instead.
let restorePromise: Promise<boolean> | null = null

// Routes whose entire page only makes sense for a capability a server might
// not have (see services/capabilities.ts) — DefaultLayout.vue already hides
// their nav entries, this is the backstop for a direct URL/bookmark/back-
// button navigation landing here anyway on a server that can't support it.
const CAPABILITY_ROUTES: Partial<
  Record<string, keyof ReturnType<typeof useAuthStore>['capabilities']>
> = {
  radio: 'internetRadio',
  'm-radio': 'internetRadio',
  stats: 'playHistoryStats',
  favorites: 'favorites',
}

// Shared by both post-auth paths below (already-authenticated and
// just-restored) so a mobile-web landing on the bare '/' — a fresh boot, or
// ServerLoginView.vue's goToRedirect() falling back to '/' — ends up on the
// mobile shell's own landing view instead of the desktop HomeView.vue
// rendered inside MobileLayout.vue. Deliberately only redirects the 'home'
// route itself, not every non-/m/ route: something like NowPlayingView.vue's
// reused artist/album links legitimately navigates to a desktop-only route
// on mobile too (see the mobile plan's notes on that view being reused
// as-is) — bouncing every one of those back here would just break the tap
// instead of leaving it a (imperfect but functional) desktop view rendered
// inside the mobile shell.
function afterAuth(to: { name?: string | symbol | null }): true | { name: string } {
  const requiredCapability = typeof to.name === 'string' ? CAPABILITY_ROUTES[to.name] : undefined
  if (requiredCapability && !authStoreCapabilityOk(requiredCapability)) {
    return { name: 'home' }
  }
  if (to.name === 'home' && isMobileWebNow()) {
    return { name: 'm-now-playing' }
  }
  return true
}

function authStoreCapabilityOk(
  capability: keyof ReturnType<typeof useAuthStore>['capabilities'],
): boolean {
  return useAuthStore().capabilities[capability]
}

// Separate from the auth guard below — pure bookkeeping, doesn't affect
// navigation outcome, so it doesn't need to share that guard's redirect
// logic. Captures the *outgoing* route's scroll position before its
// component gets torn down — by the time scrollBehavior above runs for the
// new route, this page's own scroll is long gone.
router.beforeEach((_to, from) => {
  scrollPositions.set(from.path, window.scrollY)
})

router.beforeEach(async (to) => {
  if (to.name === 'login') return true

  const authStore = useAuthStore()
  if (authStore.authenticated) return afterAuth(to)

  if (!restorePromise) {
    restorePromise = authStore.restore().finally(() => {
      restorePromise = null
    })
  }
  const restored = await restorePromise
  if (restored) return afterAuth(to)

  return { name: 'login', query: { redirect: to.fullPath } }
})

export default router
