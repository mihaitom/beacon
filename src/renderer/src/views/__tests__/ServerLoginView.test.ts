import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { getHealth } from '@/services/connect/config'
import type { PlexServer } from '@/services/connect/types'
import ServerLoginView from '../ServerLoginView.vue'

// created() calls this before the form is ever shown; a real one would try
// to reach the connect backend from jsdom.
vi.mock('@/services/connect/config', () => ({ getHealth: vi.fn() }))

const vuetify = createVuetify({ components, directives })
const RECENT_KEY = 'beacon.recent-server-urls'

/** The parts of the component instance these tests read or drive. The view
 * is an options component, so its data/computed/methods all live directly
 * on the instance. */
interface LoginVm {
  serverUrl: string
  username: string
  password: string
  submitting: boolean
  recentServerUrls: string[]
  selectedServerType: 'subsonic' | 'jellyfin' | 'plex'
  checkingLock: boolean
  serverLock: { url: string; server_type: string } | null
  authMode: 'password' | 'quickconnect'
  quickConnectCode: string | null
  quickConnectSecret: string | null
  quickConnectTimer: ReturnType<typeof setTimeout> | null
  plexCode: string | null
  plexPinId: number | null
  plexWaiting: boolean
  plexPickingServer: boolean
  plexServers: PlexServer[]
  plexUsername: string
  plexTimer: ReturnType<typeof setTimeout> | null
  readonly locked: boolean
  readonly quickConnectMode: boolean
  readonly plexMode: boolean
  readonly showSubmitButton: boolean
  submit(): Promise<void>
  selectServerType(option: { type: string; locked: boolean }): void
  setAuthMode(mode: 'password' | 'quickconnect'): void
  rememberServerUrl(url: string): void
  forgetServerUrl(url: string): void
  startQuickConnect(): Promise<void>
  pollQuickConnect(): Promise<void>
  cancelQuickConnect(): void
  pollPlexLogin(): Promise<void>
  cancelPlexLogin(): void
}

type Health = Awaited<ReturnType<typeof getHealth>>

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
      { path: '/albums', component: { template: '<div />' } },
    ],
  })
}

async function mountLogin(
  opts: { health?: Partial<Health>; healthRejects?: boolean; route?: string } = {},
) {
  if (opts.healthRejects) {
    vi.mocked(getHealth).mockRejectedValue(new Error('connect unreachable'))
  } else {
    vi.mocked(getHealth).mockResolvedValue({ ...opts.health } as Health)
  }

  const auth = useAuthStore()
  // Every network-touching action the view can reach, neutralised up front;
  // each test re-stubs the one it actually exercises.
  auth.loadConnectDefaults = vi.fn().mockResolvedValue(undefined)
  auth.login = vi.fn().mockResolvedValue(undefined)
  auth.startJellyfinQuickConnect = vi.fn()
  auth.pollJellyfinQuickConnect = vi.fn()
  auth.startPlexAuth = vi.fn()
  auth.pollPlexAuth = vi.fn()
  auth.fetchPlexServers = vi.fn()
  auth.selectPlexServer = vi.fn().mockResolvedValue(undefined)

  const router = makeRouter()
  await router.push(opts.route ?? '/login')
  await router.isReady()
  const push = vi.spyOn(router, 'push')

  const wrapper = mount(ServerLoginView, { global: { plugins: [vuetify, i18n, router] } })
  await flushPromises()
  return { wrapper, auth, push, vm: wrapper.vm as unknown as LoginVm }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ServerLoginView server-lock check', () => {
  it('adopts a locked server and hides the choice', async () => {
    const { vm } = await mountLogin({
      health: { server_lock: { url: 'https://only.example.com', server_type: 'jellyfin' } },
    })

    expect(vm.locked).toBe(true)
    expect(vm.serverUrl).toBe('https://only.example.com')
    expect(vm.selectedServerType).toBe('jellyfin')
  })

  it('falls back to the normal form when the check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { vm } = await mountLogin({ healthRejects: true })

    // An unreachable connect backend must not leave the form stuck behind
    // its spinner: the lock check is a nice-to-have, not a precondition.
    expect(vm.checkingLock).toBe(false)
    expect(vm.locked).toBe(false)
  })
})

describe('ServerLoginView remembered server URLs', () => {
  it('keeps the most recent first and never duplicates a server', async () => {
    const { vm } = await mountLogin()

    vm.rememberServerUrl('https://a.example.com')
    vm.rememberServerUrl('https://b.example.com')
    vm.rememberServerUrl('https://a.example.com')

    expect(vm.recentServerUrls).toEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('caps the list instead of growing it forever', async () => {
    const { vm } = await mountLogin()

    for (let i = 0; i < 12; i++) vm.rememberServerUrl(`https://s${i}.example.com`)

    expect(vm.recentServerUrls).toHaveLength(8)
    expect(vm.recentServerUrls[0]).toBe('https://s11.example.com')
  })

  it('ignores an empty URL', async () => {
    const { vm } = await mountLogin()

    vm.rememberServerUrl('')

    expect(vm.recentServerUrls).toEqual([])
  })

  it('persists across a remount', async () => {
    const first = await mountLogin()
    first.vm.rememberServerUrl('https://kept.example.com')

    setActivePinia(createPinia())
    const second = await mountLogin()

    expect(second.vm.recentServerUrls).toEqual(['https://kept.example.com'])
  })

  it('starts empty when the stored list is corrupt rather than failing to mount', async () => {
    localStorage.setItem(RECENT_KEY, '{not json')

    const { vm } = await mountLogin()

    expect(vm.recentServerUrls).toEqual([])
  })

  it('forgetting a suggestion leaves what is typed in the field alone', async () => {
    const { vm } = await mountLogin()
    vm.rememberServerUrl('https://a.example.com')
    vm.serverUrl = 'https://a.example.com'

    vm.forgetServerUrl('https://a.example.com')

    // Same as deleting a browser's saved-address suggestion: it drops the
    // suggestion, it does not clear the address bar.
    expect(vm.recentServerUrls).toEqual([])
    expect(vm.serverUrl).toBe('https://a.example.com')
  })
})

describe('ServerLoginView submit', () => {
  it('remembers the URL the store normalised, not the one typed', async () => {
    const { vm, auth } = await mountLogin()
    // login() strips the trailing slash before storing it. Remembering the
    // raw input instead would accumulate both forms as separate entries.
    auth.login = vi.fn().mockImplementation(async () => {
      auth.serverUrl = 'https://nav.example.com'
    })
    vm.serverUrl = 'https://nav.example.com/'

    await vm.submit()

    expect(vm.recentServerUrls).toEqual(['https://nav.example.com'])
  })

  it('neither remembers nor navigates when the login fails', async () => {
    const { vm, auth, push } = await mountLogin()
    auth.login = vi.fn().mockRejectedValue(new Error('bad credentials'))
    vm.serverUrl = 'https://nav.example.com'

    await vm.submit()

    expect(vm.recentServerUrls).toEqual([])
    expect(push).not.toHaveBeenCalled()
    // The button has to become usable again, or a mistyped password locks
    // the form for good.
    expect(vm.submitting).toBe(false)
  })

  it('returns to the redirect the route carried', async () => {
    const { vm, push } = await mountLogin({ route: '/login?redirect=/albums' })

    await vm.submit()

    expect(push).toHaveBeenCalledWith('/albums')
  })

  it('goes home when no redirect was given', async () => {
    const { vm, push } = await mountLogin()

    await vm.submit()

    expect(push).toHaveBeenCalledWith('/')
  })

  it('starts the Plex flow instead of a password login', async () => {
    const { vm, auth } = await mountLogin()
    auth.startPlexAuth = vi
      .fn()
      .mockResolvedValue({ code: 'ABCD', authUrl: 'https://plex.tv/link', pinId: 7 })
    auth.pollPlexAuth = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('open', vi.fn())
    vm.selectedServerType = 'plex'

    await vm.submit()

    expect(auth.startPlexAuth).toHaveBeenCalled()
    expect(auth.login).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('requests a Quick Connect code instead of a password login', async () => {
    const { vm, auth } = await mountLogin()
    auth.startJellyfinQuickConnect = vi.fn().mockResolvedValue({ code: '123456', secret: 's' })
    auth.pollJellyfinQuickConnect = vi.fn().mockResolvedValue(false)
    vm.selectedServerType = 'jellyfin'
    vm.authMode = 'quickconnect'

    await vm.submit()

    expect(auth.startJellyfinQuickConnect).toHaveBeenCalled()
    expect(auth.login).not.toHaveBeenCalled()
    expect(vm.quickConnectCode).toBe('123456')
    vm.cancelQuickConnect()
  })
})

describe('ServerLoginView switching server type', () => {
  it('drops Quick Connect when leaving Jellyfin', async () => {
    const { vm } = await mountLogin()
    vm.selectedServerType = 'jellyfin'
    vm.authMode = 'quickconnect'
    vm.quickConnectCode = '123456'
    vm.quickConnectSecret = 'secret'

    vm.selectServerType({ type: 'subsonic', locked: false })

    // Quick Connect exists only for Jellyfin — a code left showing under a
    // Subsonic form could never be approved.
    expect(vm.authMode).toBe('password')
    expect(vm.quickConnectCode).toBeNull()
  })

  it('cancels a pending Plex PIN when leaving Plex', async () => {
    const { vm } = await mountLogin()
    vm.selectedServerType = 'plex'
    vm.plexCode = 'ABCD'
    vm.plexPinId = 7
    vm.plexWaiting = true

    vm.selectServerType({ type: 'subsonic', locked: false })

    expect(vm.plexPinId).toBeNull()
    expect(vm.plexWaiting).toBe(false)
  })

  it('ignores a locked option', async () => {
    const { vm } = await mountLogin()

    vm.selectServerType({ type: 'jellyfin', locked: true })

    expect(vm.selectedServerType).toBe('subsonic')
  })

  it('re-selecting the current auth mode leaves a showing code alone', async () => {
    const { vm } = await mountLogin()
    vm.selectedServerType = 'jellyfin'
    vm.authMode = 'quickconnect'
    vm.quickConnectCode = '123456'
    vm.quickConnectSecret = 'secret'

    vm.setAuthMode('quickconnect')

    // Without the early return this would cancel the very code the user is
    // in the middle of approving on another device.
    expect(vm.quickConnectCode).toBe('123456')
  })
})

describe('ServerLoginView Quick Connect polling', () => {
  it('stops polling when the user cancels while a poll is in flight', async () => {
    vi.useFakeTimers()
    const { vm, auth } = await mountLogin()
    let resolvePoll: (v: boolean) => void = () => {}
    auth.pollJellyfinQuickConnect = vi
      .fn()
      .mockReturnValue(new Promise<boolean>((r) => (resolvePoll = r)))
    vm.quickConnectSecret = 'secret'
    const before = vi.getTimerCount()

    const polling = vm.pollQuickConnect()
    vm.cancelQuickConnect()
    resolvePoll(false)
    await polling

    // The in-flight poll must not schedule another round after the user
    // backed out, or the code keeps being polled with nothing on screen.
    expect(vm.quickConnectTimer).toBeNull()
    expect(vi.getTimerCount()).toBe(before)
  })

  it('schedules the next poll while approval is still pending', async () => {
    vi.useFakeTimers()
    const { vm, auth } = await mountLogin()
    auth.pollJellyfinQuickConnect = vi.fn().mockResolvedValue(false)
    vm.quickConnectSecret = 'secret'
    // Counted as a delta: Vuetify keeps a timer of its own alive under the
    // mounted form, so the absolute count is not this view's to assert on.
    const before = vi.getTimerCount()

    await vm.pollQuickConnect()

    expect(vi.getTimerCount()).toBe(before + 1)
    expect(vm.quickConnectTimer).not.toBeNull()
    vm.cancelQuickConnect()
  })

  it('returns to the code screen when polling errors out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { vm, auth } = await mountLogin()
    auth.pollJellyfinQuickConnect = vi.fn().mockRejectedValue(new Error('gone'))
    vm.quickConnectCode = '123456'
    vm.quickConnectSecret = 'secret'

    await vm.pollQuickConnect()

    // Leaving a now-dead code on screen would offer no way to retry.
    expect(vm.quickConnectCode).toBeNull()
    expect(vm.quickConnectSecret).toBeNull()
  })

  it('does nothing without a secret', async () => {
    const { vm, auth } = await mountLogin()

    await vm.pollQuickConnect()

    expect(auth.pollJellyfinQuickConnect).not.toHaveBeenCalled()
  })
})

describe('ServerLoginView Plex polling', () => {
  const server = (name: string): PlexServer =>
    ({ name, clientIdentifier: name, connections: [] }) as unknown as PlexServer

  it('discards a result the user already cancelled', async () => {
    const { vm, auth } = await mountLogin()
    let resolvePoll: (v: { accountToken: string; username: string } | null) => void = () => {}
    auth.pollPlexAuth = vi.fn().mockReturnValue(new Promise((r) => (resolvePoll = r)))
    vm.plexPinId = 7

    const polling = vm.pollPlexLogin()
    vm.cancelPlexLogin()
    resolvePoll({ accountToken: 't', username: 'someone' })
    await polling

    // An approval that lands after the user backed out must not sign them
    // in behind a screen they already left.
    expect(auth.fetchPlexServers).not.toHaveBeenCalled()
    expect(vm.plexUsername).toBe('')
  })

  it('signs straight in when the account has exactly one server', async () => {
    const { vm, auth, push } = await mountLogin()
    auth.pollPlexAuth = vi.fn().mockResolvedValue({ accountToken: 't', username: 'someone' })
    auth.fetchPlexServers = vi.fn().mockResolvedValue([server('home')])
    vm.plexPinId = 7

    await vm.pollPlexLogin()

    expect(auth.selectPlexServer).toHaveBeenCalled()
    expect(push).toHaveBeenCalled()
    expect(vm.plexPickingServer).toBe(false)
  })

  it('asks which server when the account has several', async () => {
    const { vm, auth } = await mountLogin()
    auth.pollPlexAuth = vi.fn().mockResolvedValue({ accountToken: 't', username: 'someone' })
    auth.fetchPlexServers = vi.fn().mockResolvedValue([server('home'), server('work')])
    vm.plexPinId = 7

    await vm.pollPlexLogin()

    expect(vm.plexPickingServer).toBe(true)
    expect(vm.plexServers).toHaveLength(2)
    expect(auth.selectPlexServer).not.toHaveBeenCalled()
  })

  it('reports an account with no servers instead of hanging on the code', async () => {
    const { vm, auth } = await mountLogin()
    auth.pollPlexAuth = vi.fn().mockResolvedValue({ accountToken: 't', username: 'someone' })
    auth.fetchPlexServers = vi.fn().mockResolvedValue([])
    vm.plexPinId = 7

    await vm.pollPlexLogin()

    expect(auth.loginError).toBeTruthy()
    expect(vm.plexPinId).toBeNull()
  })
})

describe('ServerLoginView teardown', () => {
  it('stops both pollers when the view goes away', async () => {
    vi.useFakeTimers()
    const { wrapper, vm, auth } = await mountLogin()
    auth.pollJellyfinQuickConnect = vi.fn().mockResolvedValue(false)
    auth.pollPlexAuth = vi.fn().mockResolvedValue(null)
    vm.quickConnectSecret = 'secret'
    vm.plexPinId = 7
    const before = vi.getTimerCount()
    await vm.pollQuickConnect()
    await vm.pollPlexLogin()
    expect(vi.getTimerCount()).toBe(before + 2)

    wrapper.unmount()

    // Both timers re-arm themselves, so one left running would keep polling
    // a signed-out backend for the life of the app.
    expect(vm.quickConnectTimer).toBeNull()
    expect(vm.plexTimer).toBeNull()
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before)
  })
})
