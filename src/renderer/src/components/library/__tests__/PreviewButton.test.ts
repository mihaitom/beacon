import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useConnectStore } from '@/stores/connect'
import { usePartyStore } from '@/stores/party'
import { usePlaybackStore } from '@/stores/playback'
import { makeSong } from '@/stores/__tests__/fixtures'
import PreviewButton from '../PreviewButton.vue'

const vuetify = createVuetify({ components, directives })
const songs = [makeSong('a'), makeSong('b')]

function mountButton(props: Record<string, unknown> = {}) {
  return mount(PreviewButton, {
    props: { songs, ...props },
    global: { plugins: [vuetify, i18n] },
  })
}

describe('PreviewButton', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('previews the songs it was given', async () => {
    const start = vi.spyOn(usePlaybackStore(), 'startPreview').mockResolvedValue()
    await mountButton().get('button').trigger('click')
    expect(start).toHaveBeenCalledWith(songs)
  })

  it('is off with nothing to preview', () => {
    expect(mountButton({ songs: [] }).get('button').attributes('disabled')).toBeDefined()
  })

  it('is on while casting, and off when party guests listen to the cast', () => {
    vi.spyOn(useConnectStore(), 'isActive', 'get').mockReturnValue(true)
    expect(mountButton().get('button').attributes('disabled')).toBeUndefined()
    usePartyStore().enabled = true
    expect(mountButton().get('button').attributes('disabled')).toBeDefined()
  })

  it('is off while this window hosts a party, whose guests would hear it', () => {
    const party = usePartyStore()
    party.enabled = true
    party.hostedHere = true
    expect(mountButton({ compact: true }).get('button').attributes('disabled')).toBeDefined()
  })

  it("a party hosted in another window reads that window's mix, not this one", () => {
    const party = usePartyStore()
    party.enabled = true
    party.hostedHere = false
    expect(mountButton().get('button').attributes('disabled')).toBeUndefined()
  })
})
