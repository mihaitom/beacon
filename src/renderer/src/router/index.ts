import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    layout?: 'auth' | 'default'
  }
}

const router = createRouter({
  history: createWebHashHistory(),
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
      path: '/tracks',
      name: 'tracks',
      component: () => import('../views/TracksView.vue'),
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
      path: '/now-playing',
      name: 'now-playing',
      component: () => import('../views/NowPlayingView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsView.vue'),
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

router.beforeEach(async (to) => {
  if (to.name === 'login') return true

  const authStore = useAuthStore()
  if (authStore.authenticated) return true

  if (!restorePromise) {
    restorePromise = authStore.restore().finally(() => {
      restorePromise = null
    })
  }
  const restored = await restorePromise
  if (restored) return true

  return { name: 'login', query: { redirect: to.fullPath } }
})

export default router
