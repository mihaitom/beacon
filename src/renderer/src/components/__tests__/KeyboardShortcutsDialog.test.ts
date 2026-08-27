import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import { SHORTCUT_HELP } from '@/services/keyboardShortcuts'
import KeyboardShortcutsDialog from '../KeyboardShortcutsDialog.vue'

const vuetify = createVuetify({ components, directives })

function mountDialog() {
  return mount(KeyboardShortcutsDialog, {
    global: { plugins: [vuetify, i18n] },
    // The dialog teleports its content out of the component tree by
    // default, which puts it beyond the wrapper's reach.
    attachTo: document.body,
  })
}

describe('KeyboardShortcutsDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // Vuetify teleports the open dialog into its own overlay container, which
  // outlives the wrapper — without clearing it, the next test finds the
  // previous test's dialog still in the document.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('stays closed until something asks for it', () => {
    mountDialog()

    expect(document.querySelector('.shortcuts-dialog')).toBeNull()
  })

  it('opens and closes again on the same event — "?" is a toggle', async () => {
    const wrapper = mountDialog()

    emitter.emit('toggleKeyboardShortcuts')
    await wrapper.vm.$nextTick()
    expect(document.querySelector('.shortcuts-dialog')).not.toBeNull()

    emitter.emit('toggleKeyboardShortcuts')
    await wrapper.vm.$nextTick()
    expect((wrapper.vm as unknown as { visible: boolean }).visible).toBe(false)
  })

  it('lists every documented shortcut, split into one keycap per key', async () => {
    const wrapper = mountDialog()

    emitter.emit('toggleKeyboardShortcuts')
    await wrapper.vm.$nextTick()

    const rows = document.querySelectorAll('.shortcut-list .shortcut-label')
    expect(rows).toHaveLength(SHORTCUT_HELP.length)
    const keycaps = [...document.querySelectorAll('.shortcut-list kbd')].map((el) => el.textContent)
    // A combination is two caps, not one reading "Ctrl + ←".
    expect(keycaps).toContain('Space')
    expect(keycaps).not.toContain('Ctrl + ←')
    expect(keycaps).toContain('←')
  })

  it('stops listening once unmounted, so a second mount is not two dialogs', async () => {
    const wrapper = mountDialog()
    wrapper.unmount()

    emitter.emit('toggleKeyboardShortcuts')

    expect(document.querySelector('.shortcuts-dialog')).toBeNull()
  })
})
