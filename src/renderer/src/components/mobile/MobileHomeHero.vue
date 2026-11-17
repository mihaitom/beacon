<template>
  <!-- Home's hero band cut down to a phone: the same three states as
     - HeroBand.vue (a song, a station, or the most recent album while
     - nothing plays), the cover beside the text instead of a wide band.
     - Its own component rather than a mode of HeroBand: that one's
     - Fanart.tv banner and text measuring are built for a wide window,
     - and its links lead to the desktop pages. -->
  <section class="mobile-home-hero" :class="`v-theme--${appearance.nightTheme}`">
    <!-- In the theme's night, like HeroBand.vue: white text over a darkened
       - picture, whatever the theme around it. -->
    <v-theme-provider :theme="appearance.nightTheme">
      <div
        v-for="(url, i) in backdrop.urls"
        :key="i"
        class="mobile-home-hero__backdrop"
        :class="{ 'mobile-home-hero__backdrop--active': i === backdrop.active }"
        :style="url ? { backgroundImage: `url(${url})` } : {}"
      />
      <div class="mobile-home-hero__scrim" />

      <div v-if="loading" class="mobile-home-hero__body">
        <v-skeleton-loader type="image" :width="COVER_SIZE" :height="COVER_SIZE" />
        <div class="mobile-home-hero__info">
          <v-skeleton-loader type="text" width="90" />
          <v-skeleton-loader type="text" width="160" />
        </div>
      </div>
      <div v-else-if="hasContent" class="mobile-home-hero__body">
        <!-- While something plays the cover leads to Now Playing, the same
           - shortcut as the player bar's; otherwise it is the suggestion and
           - plays it, like the button. -->
        <cover-art
          :cover-art-id="coverId"
          :radio-favicon="radioFavicon"
          :size="COVER_SIZE"
          class="mobile-home-hero__cover cover-shadow"
          @click="onCoverClick"
          @loaded="loadedSrc = $event"
        />
        <div class="mobile-home-hero__info">
          <div class="eyebrow-label">{{ eyebrow }}</div>
          <h1 class="display-title mobile-home-hero__title">{{ title }}</h1>
          <div class="mobile-home-hero__subtitle text-body-small">
            <template v-if="artistName">
              <router-link v-if="artistId" :to="`/m/artists/${artistId}`">{{
                artistName
              }}</router-link>
              <span v-else>{{ artistName }}</span>
              <template v-if="albumName">
                ·
                <router-link v-if="albumId" :to="`/m/albums/${albumId}`">{{
                  albumName
                }}</router-link>
                <span v-else>{{ albumName }}</span>
              </template>
            </template>
            <template v-else>{{ subtitle }}</template>
          </div>
          <div class="mobile-home-hero__actions">
            <v-btn
              color="primary"
              :prepend-icon="isPlayingThis ? 'mdi-pause' : 'mdi-play'"
              rounded="pill"
              size="small"
              @click="$emit('play')"
            >
              {{ isPlayingThis ? $t('home.paused') : $t('home.keepListening') }}
            </v-btn>
            <v-btn
              v-if="canStartRadio"
              prepend-icon="mdi-radio-tower"
              rounded="pill"
              size="small"
              variant="tonal"
              :loading="radioLoading"
              @click="$emit('song-radio')"
            >
              {{ $t('library.songRadio') }}
            </v-btn>
          </div>
        </div>
      </div>
      <div v-else class="mobile-home-hero__body">
        <div class="mobile-home-hero__info">
          <h1 class="display-title mobile-home-hero__title">{{ $t('home.readyToPlay') }}</h1>
          <div class="mobile-home-hero__subtitle text-body-small">
            {{ $t('home.nothingHeardYet') }}
          </div>
        </div>
      </div>
    </v-theme-provider>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import type { RadioFaviconRequest } from '@/services/connect/radio'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'
import { useLibraryStore } from '@/stores/library'
import { useAppearanceStore } from '@/stores/appearance'

/** Big enough to read as the page's picture, small enough to leave the
 * title two lines beside it on a 360px phone. */
const COVER_SIZE = 104

export default {
  name: 'MobileHomeHero',
  components: { CoverArt },
  props: {
    coverId: { type: String as PropType<string | null>, default: null },
    radioFavicon: { type: Object as PropType<RadioFaviconRequest | null>, default: null },
    eyebrow: { type: String, default: '' },
    title: { type: String, default: '' },
    subtitle: { type: String, default: '' },
    artistName: { type: String as PropType<string | null>, default: null },
    artistId: { type: String as PropType<string | null>, default: null },
    albumName: { type: String as PropType<string | null>, default: null },
    albumId: { type: String as PropType<string | null>, default: null },
    /** Where the cover leads while something plays; null makes it play. */
    coverTo: { type: String as PropType<string | null>, default: null },
    isPlayingThis: { type: Boolean, default: false },
    hasContent: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    canStartRadio: { type: Boolean, default: false },
    radioLoading: { type: Boolean, default: false },
  },
  emits: ['play', 'song-radio'],
  data() {
    return {
      COVER_SIZE,
      backdrop: createBackdropLayers(),
      // A station logo has no URL until <cover-art> reports what it showed.
      loadedSrc: null as string | null,
    }
  },
  computed: {
    appearance() {
      return useAppearanceStore()
    },
    backdropUrl(): string | null {
      if (this.coverId) return useLibraryStore().client().coverArtUrl(this.coverId, 300)
      return this.loadedSrc
    },
  },
  watch: {
    backdropUrl: {
      immediate: true,
      handler(url: string | null) {
        showBackdrop(this.backdrop, url)
      },
    },
  },
  methods: {
    onCoverClick() {
      if (this.coverTo) this.$router.push(this.coverTo)
      else this.$emit('play')
    },
  },
}
</script>

<style scoped>
/* Bleeds to the screen's edges, under the container's own padding, so the
 * picture reads as the top of the page rather than a card on it. */
.mobile-home-hero {
  position: relative;
  overflow: hidden;
  isolation: isolate;
  margin: -16px -16px 24px;
  min-height: 184px;
  display: flex;
  align-items: center;
  background: rgb(var(--v-theme-background));
  color: rgb(var(--v-theme-on-background));
}

/* Same blur and fade speed as HeroBand.vue's cover backdrop. */
.mobile-home-hero__backdrop {
  position: absolute;
  inset: -20px;
  background-size: cover;
  background-position: center;
  filter: blur(32px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
  opacity: 0;
  transition: opacity 0.6s ease;
}

.mobile-home-hero__backdrop--active {
  opacity: 1;
}

/* Ends in the page's own colour, so the band runs out into the list below
 * instead of stopping at an edge. */
.mobile-home-hero__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(var(--v-theme-background), 0.25),
    rgba(var(--v-theme-background), 0.6) 60%,
    rgb(var(--v-theme-background))
  );
}

.mobile-home-hero__body {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 24px 16px;
  width: 100%;
}

.mobile-home-hero__cover {
  flex-shrink: 0;
  cursor: pointer;
}

.mobile-home-hero__info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mobile-home-hero__title {
  font-size: 1.45rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mobile-home-hero__subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.mobile-home-hero__subtitle a {
  color: inherit;
  text-decoration: none;
}

.mobile-home-hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

@media (prefers-reduced-motion: reduce) {
  .mobile-home-hero__backdrop {
    transition: none;
  }
}
</style>
