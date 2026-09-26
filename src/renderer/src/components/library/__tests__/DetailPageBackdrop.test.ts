import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { extractLeftEdgeGradient } from '@/services/edgeFill'
import { personAtLeftEdge } from '@/services/personAtEdge'
import DetailPageBackdrop from '../DetailPageBackdrop.vue'

vi.mock('@/services/edgeFill', () => ({ extractLeftEdgeGradient: vi.fn(async () => null) }))
vi.mock('@/services/personAtEdge', () => ({ personAtLeftEdge: vi.fn(async () => false) }))

function layers(wrapper: ReturnType<typeof mount>, selector = '.detail-page__backdrop') {
  return wrapper.findAll(selector).map((layer) => ({
    image: (layer.element as HTMLElement).style
      .getPropertyValue('--backdrop-image')
      .replace(/"/g, ''),
    shown: layer.classes('detail-page__backdrop--shown'),
    photo: layer.classes('detail-page__backdrop--photo'),
  }))
}

describe('DetailPageBackdrop', () => {
  it('keeps the previous image on its layer while the new one fades in', async () => {
    // One layer swapping its background-image would cut, not fade.
    const wrapper = mount(DetailPageBackdrop, { props: { url: 'a.jpg', isPhoto: true } })
    await wrapper.setProps({ url: 'b.jpg' })

    const [old, next] = [...layers(wrapper)].sort((x) => (x.shown ? 1 : -1))
    expect(old).toMatchObject({ image: 'url(a.jpg)', shown: false })
    expect(next).toMatchObject({ image: 'url(b.jpg)', shown: true })
  })

  it('fades the image out rather than dropping it when the url is cleared', async () => {
    const wrapper = mount(DetailPageBackdrop, { props: { url: 'a.jpg', isPhoto: true } })
    await wrapper.setProps({ url: null })

    expect(layers(wrapper).some((layer) => layer.image === 'url(a.jpg)')).toBe(true)
    expect(layers(wrapper).every((layer) => !layer.shown)).toBe(true)
  })

  it('keeps each layer to its own kind, photo or blurred cover', async () => {
    const wrapper = mount(DetailPageBackdrop, { props: { url: 'photo.jpg', isPhoto: true } })
    await wrapper.setProps({ url: 'cover.jpg', isPhoto: false })

    const byImage = Object.fromEntries(layers(wrapper).map((layer) => [layer.image, layer]))
    expect(byImage['url(photo.jpg)']?.photo).toBe(true)
    expect(byImage['url(cover.jpg)']?.photo).toBe(false)
  })
})

describe('DetailPageBackdrop continued edge', () => {
  afterEach(() => {
    vi.mocked(extractLeftEdgeGradient).mockReset()
    vi.mocked(personAtLeftEdge).mockReset()
  })

  async function filled(edge: string | null, person: boolean) {
    vi.mocked(extractLeftEdgeGradient).mockResolvedValue(edge)
    vi.mocked(personAtLeftEdge).mockResolvedValue(person)
    const wrapper = mount(DetailPageBackdrop, { props: { url: 'photo.jpg', isPhoto: true } })
    await flushPromises()
    return wrapper.find('.detail-page__backdrop--filled').exists()
  }

  it('continues a calm edge with nobody at it', async () => {
    expect(await filled('linear-gradient(to bottom, rgb(1, 2, 3) 50%)', false)).toBe(true)
  })

  it('continues nothing where a person reaches the edge, calm as it is', async () => {
    expect(await filled('linear-gradient(to bottom, rgb(1, 2, 3) 50%)', true)).toBe(false)
  })

  it('continues nothing from a busy edge', async () => {
    expect(await filled(null, false)).toBe(false)
  })
})
