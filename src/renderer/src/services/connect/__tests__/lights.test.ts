// connect's /lights reply goes through fetchConnect intact. The other lights
// tests mock getLights away, which once hid a reply field that fetchConnect
// took for an error report.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { getLights, type LightsState } from '../lights'

const REPLY: LightsState = {
  paired: false,
  found: [{ host: '10.0.0.2', id: 'abc' }],
  bridge: null,
  reachable: null,
  areas: null,
  area_id: null,
  enabled: false,
  lead_ms: 80,
  style: 'pulse',
  colour_mode: 'palette',
  fixed_colour: '#3b6bff',
  theme_colour: '#f5a94e',
  theme_follows_picture: true,
  brightness: 100,
  picture: null,
  playing: false,
  start_error: null,
}

describe('getLights', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().apiUrl = 'http://connect.local'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('hands back what connect sent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(REPLY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(getLights()).resolves.toEqual(REPLY)
  })
})
