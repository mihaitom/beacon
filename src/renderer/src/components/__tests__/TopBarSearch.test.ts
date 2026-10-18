import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { emitter } from '@/emitter'
import TopBarSearch from '../TopBarSearch.vue'

const vuetify = createVuetify({ components, directives })

interface SearchVm {
  query: string
  readonly onSearchPage: boolean
  focus(): void
  onEscape(): void
  submit(): void
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/search', name: 'search', component: { template: '<div />' } },
    ],
  })
}

async function mountSearch(startRoute = '/') {
  const router = makeRouter()
  await router.push(startRoute)
  await router.isReady()
  const push = vi.spyOn(router, 'push')
  const wrapper = mount(TopBarSearch, { global: { plugins: [vuetify, i18n, router] } })
  await flushPromises()
  return { wrapper, router, push, vm: wrapper.vm as unknown as SearchVm }
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** Swapped in for the real field's blur: the real one ends up in jsdom's
 * native blur, which rejects being called with Vuetify's proxy as `this`.
 * Spied on the field itself rather than swapping $refs out - Vue owns that
 * object and repopulates it on every render. */
function stubFieldBlur(wrapper: ReturnType<typeof mount>) {
  const field = wrapper.findComponent({ name: 'VTextField' })
  return vi.spyOn(field.vm as unknown as { blur: () => void }, 'blur').mockImplementation(() => {})
}

describe('TopBarSearch on an ordinary page', () => {
  it('is a field from the start, not an icon to click first', async () => {
    const { wrapper } = await mountSearch('/')

    expect(wrapper.find('input').exists()).toBe(true)
  })

  it('forgets a half-typed query on escape and lets go of the cursor', async () => {
    const { wrapper, vm } = await mountSearch('/')
    const blur = stubFieldBlur(wrapper)
    vm.query = 'half typed'

    vm.onEscape()

    // Never submitted, so it is discarded; and the keyboard shortcuts only
    // answer again once the field no longer has focus.
    expect(vm.query).toBe('')
    expect(blur).toHaveBeenCalled()
  })

  it('takes the cursor when Ctrl+K asks for the search', async () => {
    const { wrapper } = await mountSearch('/')
    const field = wrapper.findComponent({ name: 'VTextField' })
    const focus = vi
      .spyOn(field.vm as unknown as { focus: () => void }, 'focus')
      .mockImplementation(() => {})

    emitter.emit('focusSearch')

    expect(focus).toHaveBeenCalled()
  })
})

describe('TopBarSearch submitting', () => {
  it('navigates to the results page with the query', async () => {
    const { vm, push } = await mountSearch('/')
    vm.query = 'moon'

    vm.submit()

    expect(push).toHaveBeenCalledWith({ path: '/search', query: { q: 'moon' } })
  })

  it('trims what it searches for', async () => {
    const { vm, push } = await mountSearch('/')
    vm.query = '  moon  '

    vm.submit()

    expect(push).toHaveBeenCalledWith({ path: '/search', query: { q: 'moon' } })
  })

  it('does nothing for an empty or blank query', async () => {
    const { vm, push } = await mountSearch('/')

    vm.query = ''
    vm.submit()
    vm.query = '   '
    vm.submit()

    // Navigating to an empty results page would be a dead end.
    expect(push).not.toHaveBeenCalled()
  })
})

describe('TopBarSearch while the results page is open', () => {
  it('adopts the query from the URL', async () => {
    const { vm } = await mountSearch('/search?q=bookmarked')

    // The query can arrive without this field being involved at all (a
    // bookmark, browser back/forward, a link) — showing an empty box while
    // results are on screen would be wrong.
    expect(vm.query).toBe('bookmarked')
  })

  it('keeps the query on escape, since the results on screen are for it', async () => {
    const { wrapper, vm } = await mountSearch('/search?q=moon')
    const blur = stubFieldBlur(wrapper)

    vm.onEscape()

    expect(vm.query).toBe('moon')
    expect(blur).toHaveBeenCalled()
  })

  it('does not overwrite what the user is typing when the query changes', async () => {
    const { vm, router } = await mountSearch('/search?q=first')
    vm.query = 'second'

    // A new search from this very field changes the route query — the
    // watcher must not then reset the field to the URL's value and undo
    // the edit the user just made.
    await router.push('/search?q=second')
    await flushPromises()

    expect(vm.query).toBe('second')
  })

  it('resets once the results page is left', async () => {
    const { vm, router } = await mountSearch('/search?q=moon')

    await router.push('/')
    await flushPromises()

    expect(vm.query).toBe('')
  })

  it('adopts the query again on returning to the results page', async () => {
    const { vm, router } = await mountSearch('/search?q=moon')
    await router.push('/')
    await flushPromises()

    await router.push('/search?q=later')
    await flushPromises()

    expect(vm.query).toBe('later')
  })
})
