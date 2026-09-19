<template>
  <div class="artist-bio">
    <!-- lang: the text falls back to English where the reader's own
       - Wikipedia has no article, and hyphenation and screen readers should
       - follow the text rather than the app. -->
    <p
      ref="text"
      :lang="lang"
      class="artist-bio__text text-body-medium"
      :class="{ 'artist-bio__text--clamped': !expanded }"
    >
      {{ text }}
    </p>
    <div class="artist-bio__footer">
      <button
        v-if="expanded || overflowing"
        type="button"
        class="artist-bio__link"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? $t('library.showLess') : $t('library.showMore') }}
      </button>
      <!-- Wikipedia's licence asks for the way back to the article. -->
      <a
        v-if="url"
        :href="url"
        target="_blank"
        rel="noopener"
        class="artist-bio__link"
        :title="$t('library.viewOnService', { service: 'Wikipedia' })"
        >Wikipedia</a
      >
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'

export default {
  name: 'ArtistBio',
  props: {
    text: { type: String, required: true },
    url: { type: String as PropType<string | null>, default: null },
    lang: { type: String, default: '' },
  },
  data() {
    return {
      expanded: false,
      // Whether the clamp actually cut anything off - a two-line paragraph
      // has nothing for "Show more" to reveal.
      overflowing: false,
      resizeObserver: null as ResizeObserver | null,
    }
  },
  watch: {
    text() {
      this.expanded = false
      void this.$nextTick(this.measure)
    },
  },
  mounted() {
    // The clamp's cut moves with the header's width, so it is measured again
    // whenever the paragraph is resized rather than once.
    this.resizeObserver = new ResizeObserver(() => this.measure())
    this.resizeObserver.observe(this.$refs.text as Element)
    this.measure()
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
  methods: {
    measure() {
      const el = this.$refs.text as HTMLElement | undefined
      if (!el || this.expanded) return
      this.overflowing = el.scrollHeight > el.clientHeight + 1
    },
  },
}
</script>

<style scoped>
.artist-bio {
  margin-top: 12px;
  /* A comfortable reading measure; the header itself runs the full width
   * of the window. */
  max-width: 72ch;
}

.artist-bio__text {
  color: rgba(255, 255, 255, 0.75);
  line-height: 1.5;
}

.artist-bio__text--clamped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}

.artist-bio__footer {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 4px;
}

/* Plain text links rather than v-btn: a button's padding would push the
 * label off the paragraph's left edge it is meant to line up with. */
.artist-bio__link {
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.8125rem;
  text-decoration: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.artist-bio__link:hover,
.artist-bio__link:focus-visible {
  color: rgba(255, 255, 255, 0.85);
  text-decoration: underline;
}
</style>
