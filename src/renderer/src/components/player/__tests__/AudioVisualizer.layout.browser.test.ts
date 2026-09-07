// Real-browser test for the one thing about this component jsdom cannot
// answer: what is actually on the canvas. jsdom has no 2D context that
// draws, so a jsdom version of this would assert against nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import { i18n } from '@/i18n'
import AudioVisualizer from '../AudioVisualizer.vue'

const vuetify = createVuetify({ components, directives })
const wrappers: VueWrapper[] = []
let host: HTMLElement | null = null

function sizedHost(width: number, height: number): HTMLElement {
  if (!host) {
    host = document.createElement('div')
    document.body.appendChild(host)
  }
  host.style.width = `${width}px`
  host.style.height = `${height}px`
  return host
}

function painted(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d')!
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let lit = 0
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) lit++
  return lit
}

describe('AudioVisualizer canvas', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    host?.remove()
    host = null
  })

  /** Resizing a canvas wipes it, and the ResizeObserver that does the
   * resizing runs after the frame's own draw() but before that frame is
   * painted - so every frame of a window drag went to the screen empty.
   * Reported live 2026-09-07 as the visualizer flickering while the window
   * was dragged.
   *
   * The render loop is stopped first, deliberately: with it running, the
   * next frame would repaint the canvas anyway and the test would pass
   * either way. What is asserted is that the resize *itself* leaves
   * something on the canvas. */
  it('leaves the bars on the canvas when its box is resized', async () => {
    await page.viewport(1200, 800)
    const wrapper = mount(AudioVisualizer, {
      props: { active: true },
      attachTo: sizedHost(600, 120),
      global: { plugins: [vuetify, i18n] },
    })
    wrappers.push(wrapper)

    const canvas = wrapper.get('canvas').element as HTMLCanvasElement
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(painted(canvas), 'nothing was drawn at all, so this proves nothing').toBeGreaterThan(0)

    const vm = wrapper.vm as unknown as { rafId: number | null }
    if (vm.rafId != null) cancelAnimationFrame(vm.rafId)
    vm.rafId = null

    const before = canvas.width
    sizedHost(900, 120)
    // Until the ResizeObserver has actually run - it is what resizes the
    // backing store, and resizing it is what wipes it.
    for (let i = 0; i < 50 && canvas.width === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(canvas.width, 'the canvas was never resized, so this proves nothing').not.toBe(before)

    expect(painted(canvas)).toBeGreaterThan(0)
  })
})
