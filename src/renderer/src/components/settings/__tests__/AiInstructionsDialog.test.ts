// The prompt is shown before it is copied: what goes into a chat is not
// something to send blind.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import AiInstructionsDialog from '../AiInstructionsDialog.vue'

const vuetify = createVuetify({ components, directives })

// Teleported otherwise, out of the wrapper's reach.
const INLINE_DIALOG = {
  props: ['persistent'],
  template: '<div class="stub-dialog"><slot /></div>',
}

const TEXT = 'Help me write an app against the API of my Beacon music server.'

function mountDialog() {
  return mount(AiInstructionsDialog, {
    props: { modelValue: true, title: 'AI instructions', text: TEXT },
    global: {
      plugins: [vuetify, i18n],
      stubs: { VDialog: INLINE_DIALOG },
    },
  })
}

describe('AiInstructionsDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the whole text before anything is copied', () => {
    const area = mountDialog().get('.ai-instructions__text textarea')
    expect((area.element as HTMLTextAreaElement).value).toBe(TEXT)
    expect(area.attributes('readonly')).toBeDefined()
  })

  it('copies exactly what it shows', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const wrapper = mountDialog()

    await wrapper.get('.ai-instructions__copy').trigger('click')

    expect(writeText).toHaveBeenCalledWith(TEXT)
  })

  it('says the copy happened, then goes back', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    const wrapper = mountDialog()

    await wrapper.get('.ai-instructions__copy').trigger('click')
    expect(wrapper.get('.ai-instructions__copy').text()).toBe(
      i18n.global.t('settings.aiInstructions.copied'),
    )

    vi.advanceTimersByTime(2000)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.ai-instructions__copy').text()).toBe(
      i18n.global.t('settings.aiInstructions.copy'),
    )
    vi.useRealTimers()
  })

  it('closes on Close', async () => {
    const wrapper = mountDialog()
    await wrapper.get('.ai-instructions__close').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })
})
