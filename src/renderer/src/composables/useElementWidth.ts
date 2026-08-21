import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** Reactive content-box width of a template ref's element, tracked via
 * ResizeObserver — used by AlbumsView/ArtistsView to work out how many
 * fixed-width cards fit per row for their virtualized grid (see
 * ALBUM_VIRTUALIZE_THRESHOLD's comment in AlbumsView.vue). Composition API
 * escape hatch, same reasoning/idiom as App.vue's own use of
 * useIsMobileWeb: the ResizeObserver lifecycle needs onMounted/
 * onBeforeUnmount, everything else in those views stays Options API. */
export function useElementWidth(target: Ref<HTMLElement | null>): Ref<number> {
  const width = ref(0)
  let observer: ResizeObserver | null = null

  onMounted(() => {
    if (!target.value) return
    observer = new ResizeObserver((entries) => {
      width.value = entries[0]?.contentRect.width ?? 0
    })
    observer.observe(target.value)
  })
  onBeforeUnmount(() => observer?.disconnect())

  return width
}
