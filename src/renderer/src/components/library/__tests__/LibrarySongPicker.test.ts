import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useLibraryStore } from '@/stores/library'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { SubsonicClient } from '@/services/subsonic/client'
import LibrarySongPicker, { songLabel } from '../LibrarySongPicker.vue'

const vuetify = createVuetify({ components, directives })

describe('LibrarySongPicker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('looks the query up in the library and drops the pick when the query changes', async () => {
    const songs = [makeSong('s1', { title: 'Roads', artist: 'Portishead' })]
    const search3 = vi.fn().mockResolvedValue({ songs })
    vi.spyOn(useLibraryStore(), 'client').mockReturnValue({ search3 } as unknown as SubsonicClient)

    const wrapper = mount(LibrarySongPicker, {
      props: { modelValue: null, label: 'Track' },
      global: { plugins: [vuetify, i18n], stubs: { CoverArt: true } },
    })
    const vm = wrapper.vm as unknown as {
      onSearch: (value: string) => void
      options: unknown[]
    }

    vm.onSearch('roads')
    // Debounced: a keystroke does not search on its own.
    expect(search3).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(search3).toHaveBeenCalledWith('roads', 15, 0, 0)
    expect(vm.options).toEqual(songs)

    // Typing over the picked song clears it; the label it shows does not.
    await wrapper.setProps({ modelValue: songs[0] })
    vm.onSearch(songLabel(songs[0]!))
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    vm.onSearch('something else')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null])
    // Let the trailing debounce fire while the mock is still in place.
    await new Promise((resolve) => setTimeout(resolve, 350))
  })
})
