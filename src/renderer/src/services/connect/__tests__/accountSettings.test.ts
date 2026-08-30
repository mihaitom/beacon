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

    it('only names the field it was actually asked to change', async () => {
      await pushAccountSettings({ autoplayBatchSize: 20 })

      const [, options] = vi.mocked(fetchConnect).mock.calls[0]!
      const body = (options as { body: { settings: Record<string, unknown> } }).body
      expect(Object.keys(body.settings)).toEqual(['autoplayBatchSize'])
    })
  })
})
