<template>
  <v-avatar v-if="rounded" :size="sizeCss" rounded="0">
    <v-img v-if="url" :src="url" width="100%" height="100%" cover eager @error="onError">
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-icon v-else :size="iconSizeCss(0.6)" :icon="fallbackIcon" />
  </v-avatar>
  <!-- v-img is sized as 100%/100% of this box, not its own copy of `size`
   - in px — a second, independent explicit size wouldn't track a CSS
   - transition put on this box's own width/height (e.g. NowPlayingView's
   - artwork-shrinks-for-lyrics animation): the box would resize smoothly
   - while the image inside it snapped instantly, since nothing here was
   - telling *it* to animate too. Filling the parent means it always
   - matches this box's current size, mid-transition or not. -->
  <div v-else class="cover-art" :style="{ width: sizeCss, height: sizeCss }">
    <v-img v-if="url" :src="url" width="100%" height="100%" cover eager @error="onError">
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <div v-else class="cover-art-fallback">
      <v-icon :size="iconSizeCss(0.5)" :icon="fallbackIcon" />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useLibraryStore } from '@/stores/library'

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
     * albums/tracks want the generic record icon, but other kinds of
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
  methods: {
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
 * file is still loading (fetched separately from the album/track data
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
