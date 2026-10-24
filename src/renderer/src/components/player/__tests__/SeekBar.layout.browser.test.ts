// Real-browser layout tests for SeekBar.vue - run via `pnpm test:layout`.
// jsdom has no flex layout, so it cannot see the labels shrinking.
import { afterEach, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import 'vuetify/styles'
// The app's own face: how wide a time label's text gets depends on it.
import '@/assets/main.css'
import { usePlaybackStore } from '@/stores/playback'
import SeekBar from '../SeekBar.vue'
import { makeSong } from '@/stores/__tests__/fixtures'

let wrapper: VueWrapper | null = null

async function mountSeekBar(duration: number) {
  setActivePinia(createPinia())
  const playback = usePlaybackStore()
  playback.setQueue([makeSong('a')], 0)
  playback.duration = duration
  wrapper = mount(
    {
      render: () =>
        h(components.VApp, null, {
          default: () => h('div', { style: 'width: 400px' }, [h(SeekBar)]),
        }),
    },
    { attachTo: document.body, global: { plugins: [createVuetify({ components })] } },
  )
  await document.fonts.load('12px "Inter Variable"')
  await wrapper.vm.$nextTick()
  return playback
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

it('keeps the waveform one width while the position counts up on a long track', async () => {
  // A width change re-spaces the bars, so the waveform visibly shifts every
  // second. Five-character times are what used to trigger it.
  const playback = await mountSeekBar(4000)

  const widths = new Set<number>()
  for (let position = 0; position < 700; position += 7) {
    playback.localPosition = position
    await wrapper!.vm.$nextTick()
    widths.add(document.querySelector('canvas')!.getBoundingClientRect().width)
  }
  expect(widths.size).toBe(1)
})

it('makes room for a three-digit minute count from the start', async () => {
  // A label too narrow for its text grows to fit it, and the waveform
  // shrinks with it the moment the minutes gain a digit.
  const playback = await mountSeekBar(999 * 60 + 59)
  const canvasWidth = () => document.querySelector('canvas')!.getBoundingClientRect().width

  const atStart = canvasWidth()
  playback.localPosition = 998 * 60 + 58
  await wrapper!.vm.$nextTick()
  expect(canvasWidth()).toBe(atStart)
})
