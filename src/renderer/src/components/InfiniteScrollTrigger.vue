<template>
  <div ref="sentinel" class="infinite-scroll-trigger" />
</template>

<script lang="ts">
export default {
  name: 'InfiniteScrollTrigger',
  props: {
    // Set while a load is already in flight (or nothing more to load) so a
    // sentinel that stays in view (e.g. a short remaining list) doesn't
    // keep firing 'trigger' in a tight loop.
    disabled: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['trigger'],
  data() {
    return {
      observer: null as IntersectionObserver | null,
      // IntersectionObserver only calls back on enter/exit transitions, not
      // on `disabled` changing — tracking the current state ourselves lets
      // the watcher below react when disabled flips back to false while the
      // sentinel never actually left the viewport (a page of results that
      // isn't tall enough to push it out of the 400px rootMargin). Without
      // this, pagination silently stalls after one page even though there's
      // more to load and disabled is false again.
      isIntersecting: false,
    }
  },
  watch: {
    disabled(value: boolean) {
      if (!value && this.isIntersecting) this.$emit('trigger')
    },
  },
  mounted() {
    this.observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries[0]?.isIntersecting ?? false
        this.isIntersecting = intersecting
        if (intersecting && !this.disabled) {
          this.$emit('trigger')
        }
      },
      // Starts loading a bit before the sentinel actually scrolls into
      // view, so content is already there by the time the user reaches it.
      { rootMargin: '400px' },
    )
    this.observer.observe(this.$refs.sentinel as Element)
  },
  beforeUnmount() {
    this.observer?.disconnect()
  },
}
</script>

<style scoped>
.infinite-scroll-trigger {
  /* Zero-height on purpose — exists only as an IntersectionObserver target,
   * not meant to take up visible layout space. */
  height: 1px;
}
</style>
