import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { PHONE_LANDSCAPE_QUERY } from './phoneLandscape'

// Matches Vuetify's default 'sm' breakpoint upper bound (960px) — deliberately
// not read off the Vuetify instance itself (via useDisplay()) so this can be
// evaluated outside component context too, see isMobileWebNow() below, used
// by router/index.ts's navigation guard before any component has mounted.
const MOBILE_BREAKPOINT_PX = 960

/** Narrow, or a phone on its side: the larger phones are wider than the
 * breakpoint in landscape and would otherwise rotate into the desktop shell.
 * A touch screen only - a short desktop window keeps the desktop layout. A
 * comma list rather than Media Queries 4's `or`, which an engine that does
 * not know it reads as "never matches". */
function mobileMediaQuery(): MediaQueryList {
  return window.matchMedia(
    `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px), (pointer: coarse) and ${PHONE_LANDSCAPE_QUERY}`,
  )
}

/** Web-build-only (Electron never shows the mobile layout — see App.vue's
 * `layout` computed) phone-sized-viewport check. `window.api` is only ever
 * present in the Electron build (see stores/auth.ts's loadConnectDefaults()
 * for the same idiom), so this is false there regardless of window size. Not
 * reactive on its own — see useIsMobileWeb() for a reactive Composition API
 * version used inside components. */
export function isMobileWebNow(): boolean {
  return !window.api && mobileMediaQuery().matches
}

/** Reactive version of isMobileWebNow() — tracks viewport width changes (a
 * browser window resized across the breakpoint, a phone rotated) for
 * App.vue's `layout` computed, per the decision that the mobile/desktop
 * layout switch reacts live rather than being decided once at login. */
export function useIsMobileWeb(): Ref<boolean> {
  const isMobile = ref(isMobileWebNow())
  const query = mobileMediaQuery()
  const update = (): void => {
    isMobile.value = isMobileWebNow()
  }
  onMounted(() => query.addEventListener('change', update))
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return isMobile
}
