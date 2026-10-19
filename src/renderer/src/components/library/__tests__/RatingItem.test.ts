import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import RatingItem from '../RatingItem.vue'
import type { Album } from '@/types/library'

const vuetify = createVuetify({ components, directives })

function mountItem(song = makeSong('s1', { rating: 3 })) {
  return mount(RatingItem, {
    props: { item: song },
    global: { plugins: [vuetify, i18n] },
  })
}

describe('RatingItem', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("rates the menu's song from its stars", () => {
    const rate = vi.spyOn(useLibraryStore(), 'rate').mockResolvedValue()
    const song = makeSong('s1', { rating: 3 })
    const wrapper = mountItem(song)

    wrapper.findComponent({ name: 'VRating' }).vm.$emit('update:modelValue', 5)

    expect(rate).toHaveBeenCalledWith(song, 5)
  })

  it('rates an album the same way', () => {
    const rate = vi.spyOn(useLibraryStore(), 'rate').mockResolvedValue()
    const album = { id: 'al1', name: 'Some Album', rating: 0 } as Album
    const wrapper = mount(RatingItem, {
      props: { item: album },
      global: { plugins: [vuetify, i18n] },
    })

    wrapper.findComponent({ name: 'VRating' }).vm.$emit('update:modelValue', 4)

    expect(rate).toHaveBeenCalledWith(album, 4)
  })

  it('is left out where the server has no star rating (Jellyfin)', () => {
    useAuthStore().serverType = 'jellyfin'

    expect(mountItem().findComponent({ name: 'VRating' }).exists()).toBe(false)
  })
})
