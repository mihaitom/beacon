<template>
  <v-avatar v-if="rounded" :size="size" rounded="0">
    <v-img v-if="url" :src="url" :width="size" :height="size" cover eager @error="onError">
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-icon v-else :size="size * 0.6" :icon="fallbackIcon" />
  </v-avatar>
  <div v-else class="cover-art" :style="{ width: `${size}px`, height: `${size}px` }">
    <v-img v-if="url" :src="url" :width="size" :height="size" cover eager @error="onError">
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <div v-else class="cover-art-fallback">
      <v-icon :size="size * 0.5" :icon="fallbackIcon" />
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
    size: {
      type: Number,
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
    candidates(): string[] {
      const coverArtUrl = this.coverArtId
        ? useLibraryStore().client().coverArtUrl(this.coverArtId, this.size)
        : null
      return [this.imageUrl, coverArtUrl].filter((u): u is string => !!u)
    },
    url(): string | null {
      return this.candidates[this.failedCount] ?? null
    },
  },
  watch: {
    // A prop change (e.g. scrolling a list where components get reused)
    // means the candidate list changed too — retry from the top.
    imageUrl() {
      this.failedCount = 0
    },
    coverArtId() {
      this.failedCount = 0
    },
  },
  methods: {
    onError() {
      this.failedCount += 1
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
