import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { fetchConnect } from '../http'
import { fetchAccountSettings, pushAccountSettings } from '../accountSettings'
import { useAuthStore } from '@/stores/auth'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

describe('accountSettings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(fetchConnect).mockResolvedValue({})
    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    auth.serverUrl = 'https://music.example.com'
    auth.username = 'alice'
  })

  describe('fetchAccountSettings', () => {
    it('sends the current account identity as query params', async () => {
      await fetchAccountSettings()

      const [path] = vi.mocked(fetchConnect).mock.calls[0]!
      expect(path).toContain('/account-settings?')
      expect(path).toContain('server_type=subsonic')
      expect(path).toContain('username=alice')
      expect(path).toContain('server_url=https')
    })
  })

  describe('pushAccountSettings', () => {
    it('wraps the patch with the current account identity', async () => {
      await pushAccountSettings({ locale: 'de' })

      const [path, options] = vi.mocked(fetchConnect).mock.calls[0]!
      expect(path).toBe('/account-settings')
      expect(options).toMatchObject({
        method: 'POST',
        body: {
          server_type: 'subsonic',
          server_url: 'https://music.example.com',
          username: 'alice',
          settings: { locale: 'de' },
        },
      })
    })

    /** Pulling the settings applies each through its setter, which pushes
     * it back - that echo must not write anything. */
    it('sends nothing for a value the server already holds', async () => {
      vi.mocked(fetchConnect).mockResolvedValueOnce({ fanartEnabled: true, songColumns: ['bpm'] })
      await fetchAccountSettings()

      await pushAccountSettings({ fanartEnabled: true })
      await pushAccountSettings({ songColumns: ['bpm'] })

      expect(fetchConnect).toHaveBeenCalledTimes(1)
    })

    it('takes an object setting in another key order for the same value', async () => {
      vi.mocked(fetchConnect).mockResolvedValueOnce({
        transitions: { mode: 'gapless', crossfadeSeconds: 6, beatmixBars: 8 },
      })
      await fetchAccountSettings()

      await pushAccountSettings({
        transitions: { beatmixBars: 8, crossfadeSeconds: 6, mode: 'gapless' },
      })

      expect(fetchConnect).toHaveBeenCalledTimes(1)
    })

    it('sends only the fields that differ, and remembers what it sent', async () => {
      vi.mocked(fetchConnect).mockResolvedValueOnce({
        castRadioDirectly: false,
        fanartEnabled: true,
      })
      await fetchAccountSettings()

      await pushAccountSettings({ castRadioDirectly: true, fanartEnabled: true })
      await pushAccountSettings({ castRadioDirectly: true })

      expect(fetchConnect).toHaveBeenCalledTimes(2)
      const [, options] = vi.mocked(fetchConnect).mock.calls[1]!
      expect((options as { body: { settings: unknown } }).body.settings).toEqual({
        castRadioDirectly: true,
      })
    })

    it("does not take one account's settings for another's", async () => {
      vi.mocked(fetchConnect).mockResolvedValueOnce({ recommendationsEnabled: true })
      await fetchAccountSettings()
      useAuthStore().username = 'carol'

      await pushAccountSettings({ recommendationsEnabled: true })

      expect(fetchConnect).toHaveBeenCalledTimes(2)
    })

    it('only names the field it was actually asked to change', async () => {
      await pushAccountSettings({ recommendationsEnabled: false })

      const [, options] = vi.mocked(fetchConnect).mock.calls[0]!
      const body = (options as { body: { settings: Record<string, unknown> } }).body
      expect(Object.keys(body.settings)).toEqual(['recommendationsEnabled'])
    })
  })
})
