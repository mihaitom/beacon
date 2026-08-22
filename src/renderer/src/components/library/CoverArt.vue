<template>
  <!-- The image is only mounted (and therefore only requested) once
   - `shouldLoad` says this cover has actually stayed in view — see
   - LOAD_SETTLE_MS. This component renders on every single row of every
   - grid/list in the app, so what it does while scrolling is the whole
   - question: loading eagerly meant a page fired off hundreds of
   - concurrent requests the instant it mounted, and v-img's own
   - intersection-based laziness (what this replaced) still meant one
   - request per row *passed*, which on a 15k-song list is 15k requests
   - for a single flick of the scroll wheel. `eager` on the v-img itself
   - is deliberate and not a contradiction: by the time it exists at all,
   - the decision to load has already been made here, and a second
   - observer inside it would only delay the request it was mounted for.
   - An always-on-screen instance (PlayerBar's own small art,
   - NowPlayingView's big one) pays only the settle delay once, on mount,
   - and nothing on any later track change — `shouldLoad` stays true for
   - this instance's lifetime. -->
  <v-avatar v-if="rounded" ref="root" :size="sizeCss" rounded="0">
    <v-img
      v-if="url && shouldLoad"
      :src="url"
      width="100%"
      height="100%"
      cover
      eager
      @error="onError"
    >
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-skeleton-loader v-else-if="url" type="image" class="cover-art-skeleton" />
    <v-icon v-else :size="iconSizeCss(0.6)" :icon="fallbackIcon" />
  </v-avatar>
  <!-- v-img is sized as 100%/100% of this box, not its own copy of `size`
   - in px — a second, independent explicit size wouldn't track a CSS
   - transition put on this box's own width/height (e.g. NowPlayingView's
   - artwork-shrinks-for-lyrics animation): the box would resize smoothly
   - while the image inside it snapped instantly, since nothing here was
   - telling *it* to animate too. Filling the parent means it always
   - matches this box's current size, mid-transition or not. -->
  <div v-else ref="root" class="cover-art" :style="{ width: sizeCss, height: sizeCss }">
    <v-img
      v-if="url && shouldLoad"
      :src="url"
      width="100%"
      height="100%"
      cover
      eager
      @error="onError"
    >
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-skeleton-loader v-else-if="url" type="image" class="cover-art-skeleton" />
    <div v-else class="cover-art-fallback">
      <v-icon :size="iconSizeCss(0.5)" :icon="fallbackIcon" />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useLibraryStore } from '@/stores/library'

// Starts the request a bit before the cover actually scrolls into view, so
// it's already there (or close to it) by the time it would otherwise pop
// in, rather than only starting the fetch the instant it crosses the
// viewport edge.
const LAZY_ROOT_MARGIN = '400px 0px'
// How long a cover has to stay within that margin before it's actually
// requested. Entering the viewport is not the same thing as being looked
// at: scrolling a 15,000-song list from the top to the bottom sweeps every
// row through it, and requesting on entry alone means every one of those
// rows fetches its art, for a list the user never stopped at — measured
// live on 2026-08-22 as exactly that, one server request per song in the
// list for a single fast scroll. A row passed at scrolling speed is on
// screen for a frame or two, far below this, so its timer is cancelled by
// the exit before it ever fires and no request is made at all; the rows
// wherever the scroll actually comes to rest are the ones that load.
//
// Kept short enough to stay invisible when scrolling normally: paired with
// LAZY_ROOT_MARGIN's 400px of lead, a cover still has this long *plus* the
// time it takes to travel those 400px before anyone can see whether it
// arrived. Raising it would start dropping covers the user genuinely
// scrolled to.
const LOAD_SETTLE_MS = 150

export default {
  name: 'CoverArt',
  props: {
    coverArtId: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** Direct image URL — tried before coverArtId when given (e.g.
     * Navidrome's artistImageUrl, a real photo rather than an album-cover
     * placeholder, already a full pre-signed URL outside our proxy). Many
     * artists have no cached photo and this 404s — falls back to
     * coverArtId, then to the icon placeholder, on load failure. */
    imageUrl: {
      type: String as PropType<string | null>,
      default: null,
    },
    // A plain number is pixels (unchanged behavior everywhere else); a
    // string is used as-is as a raw CSS size (e.g. NowPlayingView.vue's
    // own "70vh" — sizing its big artwork off the viewport instead of a
    // fixed pixel figure that reads too small on a tall window and too
    // large on a short one). See sizeCss/fetchSize/iconSizeCss below for
    // how each of this component's three actual uses of `size` (its own
    // CSS box, the resolution requested from the media server, and the
    // fallback icon's proportional size) handle either shape.
    size: {
      type: [Number, String] as PropType<number | string>,
      default: 160,
    },
    rounded: {
      type: Boolean,
      default: false,
    },
    /** Icon shown when there's no cover (and no imageUrl fallback either) —
     * albums/songs want the generic record icon, but other kinds of
     * covers (playlists, ...) read oddly with that, so it's overridable. */
    fallbackIcon: {
      type: String,
      default: 'mdi-album',
    },
  },
  data() {
    return {
      // Index into the candidate list below — advances on @error until
      // exhausted, at which point `url` returns null (icon placeholder).
      failedCount: 0,
      // Whether this cover has earned its request yet — see LOAD_SETTLE_MS.
      // One-way: once true it stays true for this instance's lifetime, so
      // scrolling a loaded cover back out of view and in again doesn't
      // re-gate it (and doesn't re-request it either, the browser cache
      // already has it).
      shouldLoad: false,
      observer: null as IntersectionObserver | null,
      settleTimer: null as number | null,
    }
  },
  computed: {
    // This component's own CSS box (width/height, both branches) — a
    // number needs "px" appended, a string (already a full CSS value) is
    // used as-is.
    sizeCss(): string {
      return typeof this.size === 'number' ? `${this.size}px` : this.size
    },
    // What resolution to actually request from the media server — needs a
    // real pixel number regardless of how this ends up displayed. A
    // numeric `size` doubles as both (unchanged behavior); a CSS size
    // string (e.g. "70vh") has no pixel figure to derive this from, so
    // this falls back to a fixed resolution generous enough for that
    // caller's biggest realistic on-screen size.
    fetchSize(): number {
      return typeof this.size === 'number' ? this.size : 640
    },
    candidates(): string[] {
      const coverArtUrl = this.coverArtId
        ? useLibraryStore().client().coverArtUrl(this.coverArtId, this.fetchSize)
        : null
      return [this.imageUrl, coverArtUrl].filter((u): u is string => !!u)
    },
    url(): string | null {
      return this.candidates[this.failedCount] ?? null
    },
  },
  watch: {
    // candidates() also depends on useLibraryStore().client(), which reads
    // the *current* auth store state on every call — not just imageUrl/
    // coverArtId. If this component's first render happens to race ahead of
    // auth actually being ready (e.g. connectToken/credential still empty
    // right at app boot — main.ts mounts before router.isReady() resolves,
    // see App.vue's own comment on that), the very first URL 404s,
    // failedCount advances past it, and candidates[failedCount] silently
    // points past the end forever — even once auth catches up moments
    // later and the *same* candidate index would now resolve to a working
    // URL, since nothing here previously reset the count for that case.
    // Watching the whole (always-freshly-built, see candidates() above)
    // array catches every reason its contents could have changed, not just
    // these two props specifically.
    candidates() {
      this.failedCount = 0
    },
  },
  mounted() {
    // Either of these means there's nothing to observe against, so the
    // choice is "load now" or "never load" — and a cover that never
    // appears is by far the worse failure. No IntersectionObserver at all
    // is jsdom under test or a very old browser; no resolvable root
    // element shouldn't happen, but see rootElement() for why $el alone
    // can't be trusted here.
    const target = this.rootElement()
    if (typeof IntersectionObserver === 'undefined' || !target) {
      this.shouldLoad = true
      return
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[entries.length - 1]?.isIntersecting) {
          this.startSettle()
        } else {
          this.cancelSettle()
        }
      },
      { rootMargin: LAZY_ROOT_MARGIN },
    )
    this.observer.observe(target)
  },
  beforeUnmount() {
    // Both matter for a virtualized list (SongTable.vue's v-virtual-scroll),
    // where rows are unmounted by the hundred while scrolling: a timer left
    // running would fire against a component that no longer exists, and an
    // observer left connected keeps a detached element alive.
    this.cancelSettle()
    this.observer?.disconnect()
    this.observer = null
  },
  methods: {
    /** The DOM element to watch. Deliberately not `this.$el`: this
     * component's two root branches have template comments between them,
     * which a dev build keeps, making the component a *fragment* — and
     * `$el` is then the first node of that fragment, i.e. a comment node,
     * which IntersectionObserver.observe() rejects outright ("parameter 1
     * is not of type 'Element'"). A ref on each branch's actual root
     * always resolves to the real element, whichever branch rendered.
     * The avatar branch's ref is a component, not an element, so its own
     * root has to be unwrapped. */
    rootElement(): Element | null {
      const root = this.$refs.root as Element | { $el?: unknown } | undefined
      if (root instanceof Element) return root
      const el = root && '$el' in root ? root.$el : null
      return el instanceof Element ? el : null
    },
    startSettle() {
      if (this.shouldLoad || this.settleTimer !== null) return
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = null
        this.shouldLoad = true
        // Nothing left to decide for this instance — see shouldLoad.
        this.observer?.disconnect()
        this.observer = null
      }, LOAD_SETTLE_MS)
    },
    cancelSettle() {
      if (this.settleTimer === null) return
      window.clearTimeout(this.settleTimer)
      this.settleTimer = null
    },
    onError() {
      this.failedCount += 1
    },
    // Fallback icon's proportional size (0.6 for the rounded avatar
    // variant, 0.5 for the plain box — see the template). CSS calc(),
    // not arithmetic on `size` directly, so this still works when `size`
    // is a viewport-relative string rather than a plain pixel number.
    iconSizeCss(fraction: number): string {
      return typeof this.size === 'number'
        ? `${this.size * fraction}px`
        : `calc(${this.size} * ${fraction})`
    },
  },
}
</script>

<style scoped>
.cover-art {
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
}

.cover-art-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.3);
}

/* Shown via v-img's own #placeholder slot for as long as the actual image
 * file is still loading (fetched separately from the album/song data
 * itself) — without this, the cover briefly renders empty/transparent
 * between "data arrived" and "image file arrived". .v-img__placeholder is
 * already position:absolute + 100%/100%, so this just needs to fill that;
 * the parent (.cover-art or the avatar) already clips to the right shape. */
.cover-art-skeleton {
  width: 100%;
  height: 100%;
  border-radius: 0;
}

.cover-art-skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
