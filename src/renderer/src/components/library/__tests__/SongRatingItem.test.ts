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
import SongRatingItem from '../SongRatingItem.vue'

const vuetify = createVuetify({ components, directives })

function mountItem(song = makeSong('s1', { rating: 3 })) {
  return mount(SongRatingItem, {
    props: { song },
    global: { plugins: [vuetify, i18n] },
  })
}

describe('SongRatingItem', () => {
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

  it('is left out where the server has no star rating (Jellyfin)', () => {
    useAuthStore().serverType = 'jellyfin'

    expect(mountItem().findComponent({ name: 'VRating' }).exists()).toBe(false)
  })
})
