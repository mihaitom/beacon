import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import TopBarSearch from '../TopBarSearch.vue'

const vuetify = createVuetify({ components, directives })

interface SearchVm {
  expanded: boolean
  query: string
  readonly onSearchPage: boolean
  expand(): Promise<void>
  collapse(): void
  onBlur(): void
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

describe('TopBarSearch on an ordinary page', () => {
  it('starts collapsed', async () => {
    const { vm } = await mountSearch('/')

    expect(vm.expanded).toBe(false)
  })

  it('collapses and forgets a half-typed query on blur', async () => {
    const { vm } = await mountSearch('/')
    await vm.expand()
    vm.query = 'half typed'

    vm.onBlur()

    // Never submitted, so it is discarded rather than left sitting open
    // in the app bar.
    expect(vm.expanded).toBe(false)
    expect(vm.query).toBe('')
  })

  it('collapses on escape', async () => {
    const { vm } = await mountSearch('/')
    await vm.expand()

    vm.onEscape()

    expect(vm.expanded).toBe(false)
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
  it('opens itself and adopts the query from the URL', async () => {
    const { vm } = await mountSearch('/search?q=bookmarked')

    // The query can arrive without this field being involved at all (a
    // bookmark, browser back/forward, a link) — showing an empty box while
    // results are on screen would be wrong.
    expect(vm.expanded).toBe(true)
    expect(vm.query).toBe('bookmarked')
  })

  it('stays open when it loses focus', async () => {
    const { vm } = await mountSearch('/search?q=moon')

    vm.onBlur()

    // A follow-up search here should not need the icon clicked again.
    expect(vm.expanded).toBe(true)
    expect(vm.query).toBe('moon')
  })

  it('keeps the field on escape instead of hiding it', async () => {
    const { wrapper, vm } = await mountSearch('/search?q=moon')
    // Spied on the real field rather than swapping $refs out: Vue owns
    // that object and repopulates it on every render.
    const field = wrapper.findComponent({ name: 'VTextField' })
    // Replaced, not just observed: the real one ends up in jsdom's native
    // blur, which rejects being called with Vuetify's proxy as `this`.
    const blur = vi
      .spyOn(field.vm as unknown as { blur: () => void }, 'blur')
      .mockImplementation(() => {})

    vm.onEscape()

    // Focus is released, but the field stays there for the next search
    // instead of collapsing back to an icon.
    expect(vm.expanded).toBe(true)
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

    expect(vm.expanded).toBe(false)
    expect(vm.query).toBe('')
  })

  it('adopts the query again on returning to the results page', async () => {
    const { vm, router } = await mountSearch('/search?q=moon')
    await router.push('/')
    await flushPromises()

    await router.push('/search?q=later')
    await flushPromises()

    expect(vm.expanded).toBe(true)
    expect(vm.query).toBe('later')
  })
})
