import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { emitter } from '@/emitter'
import ToastSnackbar from '../toast.vue'

const vuetify = createVuetify({ components, directives })

function mountToasts() {
  return mount(ToastSnackbar, { global: { plugins: [vuetify] } })
}

describe('ToastSnackbar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    emitter.all.clear()
  })

  it('dismisses a toast on its own after the default timeout', async () => {
    const wrapper = mountToasts()
    emitter.emit('toast', ['information', 'Hi', 'there'])
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.toast')).toHaveLength(1)

    vi.advanceTimersByTime(12_000)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })

  it('honours a longer per-toast timeout', async () => {
    /** A toast that asks a question needs longer on screen than one that
     * just reports something — see Toast.timeoutMs. */
    const wrapper = mountToasts()
    emitter.emit('toast', {
      level: 'error',
      title: 'Interrupted',
      message: 'Resume?',
      timeoutMs: 45_000,
    })
    await wrapper.vm.$nextTick()

    vi.advanceTimersByTime(12_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.toast')).toHaveLength(1)

    vi.advanceTimersByTime(33_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })

  it('stops the countdown while the pointer is over it', async () => {
    /** The whole point for an actionable toast: reaching for it must not be
     * the gesture that makes it disappear. */
    const wrapper = mountToasts()
    emitter.emit('toast', ['information', 'Hi', 'there'])
    await wrapper.vm.$nextTick()

    await wrapper.get('.toast').trigger('mouseenter')
    vi.advanceTimersByTime(60_000)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.toast')).toHaveLength(1)
  })

  it('starts the countdown again once the pointer leaves', async () => {
    const wrapper = mountToasts()
    emitter.emit('toast', ['information', 'Hi', 'there'])
    await wrapper.vm.$nextTick()

    await wrapper.get('.toast').trigger('mouseenter')
    vi.advanceTimersByTime(60_000)
    await wrapper.get('.toast').trigger('mouseleave')
    vi.advanceTimersByTime(12_000)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })

  it('runs a toast’s action from its button and dismisses it', async () => {
    const wrapper = mountToasts()
    const onClick = vi.fn()
    emitter.emit('toast', {
      level: 'error',
      title: 'Playback interrupted',
      message: 'Küche ended the connection.',
      action: { label: 'Resume', onClick },
    })
    await wrapper.vm.$nextTick()

    const button = wrapper.find('.toast-action')
    expect(button.text()).toBe('Resume')
    await button.trigger('click')

    expect(onClick).toHaveBeenCalledOnce()
    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })

  it('does not act on a plain toast when its body is clicked', async () => {
    /** The action used to be "click anywhere on the toast", which is both
     * undiscoverable and easy to hit while reaching for the close button. */
    const wrapper = mountToasts()
    const onClick = vi.fn()
    emitter.emit('toast', {
      level: 'error',
      title: 'Playback interrupted',
      message: 'Küche ended the connection.',
      action: { label: 'Resume', onClick },
    })
    await wrapper.vm.$nextTick()

    await wrapper.find('.toast-body').trigger('click')

    expect(onClick).not.toHaveBeenCalled()
    expect(wrapper.findAll('.toast')).toHaveLength(1)
  })

  it('renders no action row for a toast that only reports something', async () => {
    const wrapper = mountToasts()
    emitter.emit('toast', ['information', 'Hi', 'there'])
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.toast-actions').exists()).toBe(false)
  })

  it('does not leave a timer running for a toast that was closed by hand', async () => {
    /** Regression guard: the dismiss timer used to outlive its toast and
     * fire against an id that no longer existed. Harmless in itself, but it
     * also meant a paused toast could never be cleaned up. */
    const wrapper = mountToasts()
    emitter.emit('toast', ['information', 'Hi', 'there'])
    await wrapper.vm.$nextTick()

    await wrapper.get('.toast-close').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.toast')).toHaveLength(0)

    // Must not throw or resurrect anything when the original deadline passes.
    vi.advanceTimersByTime(12_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })
})
