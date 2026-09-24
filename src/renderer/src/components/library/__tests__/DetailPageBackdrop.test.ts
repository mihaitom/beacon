import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DetailPageBackdrop from '../DetailPageBackdrop.vue'

function layers(wrapper: ReturnType<typeof mount>, selector = '.detail-page__backdrop') {
  return wrapper.findAll(selector).map((layer) => ({
    image: (layer.element as HTMLElement).style.backgroundImage.replace(/"/g, ''),
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
