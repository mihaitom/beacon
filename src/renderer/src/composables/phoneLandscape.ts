import { defineComponent } from 'vue'

/** A phone held sideways. Told apart by its height, not its width: phones
 * stay under ~450px tall in landscape while the smallest tablet (iPad mini)
 * is 744, but their landscape widths run from ~640px to beyond the 960px
 * shell breakpoint (see useIsMobileWeb.ts). */
export const PHONE_LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 500px)'

/** Options-API mixin: `phoneLandscape`, kept live across rotations. */
export const phoneLandscapeMixin = defineComponent({
  // Read in data() rather than created(): provide() runs in between, and
  // what it builds may already depend on the answer.
  data() {
    const query = window.matchMedia(PHONE_LANDSCAPE_QUERY)
    return {
      phoneLandscape: query.matches,
      phoneLandscapeQuery: query as MediaQueryList | null,
    }
  },
  created() {
    this.phoneLandscapeQuery?.addEventListener('change', this.onPhoneLandscapeChange)
  },
  beforeUnmount() {
    this.phoneLandscapeQuery?.removeEventListener('change', this.onPhoneLandscapeChange)
  },
  methods: {
    onPhoneLandscapeChange(event: MediaQueryListEvent): void {
      this.phoneLandscape = event.matches
    },
  },
})
