import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { initAccountScopedStores } from '../accountScopedStores'
import { fetchAccountSettings } from '@/services/connect/accountSettings'
import { useAuthStore } from '@/stores/auth'
import { useRecommendationsStore } from '@/stores/recommendations'
import { useLyricsProvidersStore, LYRIC_PROVIDERS } from '@/stores/lyricsProviders'
import { useAutoplayStore, DEFAULT_AUTOPLAY_BATCH_SIZE } from '@/stores/autoplay'
import { browserLocale, getLocale } from '@/i18n'
import { setLocale } from '@/services/localeSetting'

vi.mock('@/services/connect/accountSettings', () => ({
  fetchAccountSettings: vi.fn(),
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

function signIn(username = 'alice'): void {
  const auth = useAuthStore()
  auth.serverType = 'subsonic'
  auth.serverUrl = 'https://music.example.com'
  auth.username = username
  auth.authenticated = true
}

/** initAccountScopedStores()'s pull-on-login half — see that module's own
 * comment. Applies whatever the server actually has through each
 * setting's real setter, and leaves anything the server has never seen
 * untouched. */
describe('accountScopedStores — pull on account change', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(fetchAccountSettings).mockReset()
  })

  it('applies every field the server has synced', async () => {
    vi.mocked(fetchAccountSettings).mockResolvedValue({
      locale: 'de',
      recommendationsEnabled: false,
      lyricsProviders: ['lrclib.net'],
      autoplayBatchSize: 20,
    })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(getLocale()).toBe('de'))

    expect(useRecommendationsStore().enabled).toBe(false)
    expect(useLyricsProvidersStore().enabled).toEqual(['lrclib.net'])
    expect(useAutoplayStore().batchSize).toBe(20)
  })

  it('leaves a field the server has never seen at its current local value', async () => {
    useAutoplayStore().setBatchSize(30)
    vi.mocked(fetchAccountSettings).mockResolvedValue({ locale: 'en' })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(getLocale()).toBe('en'))

    // autoplayBatchSize was absent from the server response — untouched.
    expect(useAutoplayStore().batchSize).toBe(30)
  })

  it('ignores a lyrics provider the server sent that this build does not recognize', async () => {
    vi.mocked(fetchAccountSettings).mockResolvedValue({
      lyricsProviders: ['lrclib.net', 'Genius'],
    })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(useLyricsProvidersStore().enabled).toEqual(['lrclib.net']))
  })

  it('applies a deliberately emptied lyrics provider selection', async () => {
    vi.mocked(fetchAccountSettings).mockResolvedValue({ lyricsProviders: [] })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(useLyricsProvidersStore().enabled).toEqual([]))
  })

  it('ignores a provider list this build recognizes nothing in', async () => {
    // A newer build synced providers that don't exist here yet. Filtering
    // that down to `[]` and applying it would switch every lyrics lookup
    // off *and* push the empty list back up, destroying the other device's
    // selection for good.
    vi.mocked(fetchAccountSettings).mockResolvedValue({ lyricsProviders: ['Genius', 'Musixmatch'] })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(fetchAccountSettings).toHaveBeenCalled())
    await nextTick()

    expect(useLyricsProvidersStore().enabled).toEqual([...LYRIC_PROVIDERS])
  })

  it('falls back to the default for a batch size that is not an offered option', async () => {
    vi.mocked(fetchAccountSettings).mockResolvedValue({ autoplayBatchSize: 500 })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(useAutoplayStore().batchSize).toBe(DEFAULT_AUTOPLAY_BATCH_SIZE))
  })

  it('ignores a non-boolean recommendations flag', async () => {
    vi.mocked(fetchAccountSettings).mockResolvedValue({
      recommendationsEnabled: 'false' as unknown as boolean,
    })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(fetchAccountSettings).toHaveBeenCalled())
    await nextTick()

    expect(useRecommendationsStore().enabled).toBe(true)
  })

  it('ignores a locale this build has no messages for', async () => {
    vi.mocked(fetchAccountSettings).mockResolvedValue({ locale: 'kl' })
    initAccountScopedStores()

    signIn()
    await nextTick()
    await vi.waitFor(() => expect(fetchAccountSettings).toHaveBeenCalled())
    await nextTick()

    expect(getLocale()).not.toBe('kl')
  })

  it('does not blow up when connect is unreachable', async () => {
    vi.mocked(fetchAccountSettings).mockRejectedValue(new Error('network down'))
    initAccountScopedStores()

    signIn()
    await nextTick()

    await vi.waitFor(() => expect(fetchAccountSettings).toHaveBeenCalled())
  })
})

/** The local half: every synced setting is *also* account-scoped in
 * localStorage, so a second account on the same device starts from its own
 * value (or the default) rather than inheriting the first one's — the
 * server pull can't cover this on its own, since it only ever carries
 * fields the server has actually seen. */
describe('accountScopedStores — local reload on account change', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(fetchAccountSettings).mockReset()
    vi.mocked(fetchAccountSettings).mockResolvedValue({})
  })

  it('does not let a second account inherit the first one settings', async () => {
    signIn('alice')
    useRecommendationsStore().setEnabled(false)
    useLyricsProvidersStore().setEnabled([])
    useAutoplayStore().setBatchSize(30)
    useAutoplayStore().setEnabled(true)

    initAccountScopedStores()
    useAuthStore().username = 'bob'
    await nextTick()

    expect(useRecommendationsStore().enabled).toBe(true)
    expect(useLyricsProvidersStore().enabled).toEqual([...LYRIC_PROVIDERS])
    expect(useAutoplayStore().batchSize).toBe(DEFAULT_AUTOPLAY_BATCH_SIZE)
    expect(useAutoplayStore().enabled).toBe(false)
  })

  it('does not let a second account inherit the first one language', async () => {
    signIn('alice')
    setLocale('de')

    initAccountScopedStores()
    useAuthStore().username = 'bob'
    await nextTick()

    // Bob has never picked a language, so he gets the browser's — not
    // Alice's. The server pull can't cover this: it returned {}.
    expect(getLocale()).toBe(browserLocale())
  })

  it('gives each account its own language back when switching between them', async () => {
    signIn('alice')
    setLocale('de')

    initAccountScopedStores()
    const auth = useAuthStore()
    auth.username = 'bob'
    await nextTick()
    setLocale('fr')

    auth.username = 'alice'
    await nextTick()

    expect(getLocale()).toBe('de')
  })

  it('gives each account its own value back when switching between them', async () => {
    signIn('alice')
    useAutoplayStore().setBatchSize(30)

    initAccountScopedStores()
    const auth = useAuthStore()
    auth.username = 'bob'
    await nextTick()
    useAutoplayStore().setBatchSize(5)

    auth.username = 'alice'
    await nextTick()

    expect(useAutoplayStore().batchSize).toBe(30)
  })
})
