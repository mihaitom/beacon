<template>
  <section class="hero-band">
    <!-- Two stacked layers, only one visible at a time, so the artwork
     - crossfades when the hero switches to a different song — see
     - services/crossfadeBackdrop.ts for why one element can't do this. -->
    <div
      v-for="(url, i) in backdrop.urls"
      :key="i"
      class="hero-backdrop"
      :class="{ 'hero-backdrop--active': i === backdrop.active }"
      :style="url ? { backgroundImage: `url(${url})` } : {}"
    />
    <div class="hero-scrim" />
    <div class="hero-content">
      <p class="hero-greeting">{{ greeting }}</p>

      <div v-if="loading" class="hero-body">
        <v-skeleton-loader type="image" width="132" height="132" class="hero-cover rounded" />
        <div class="hero-info min-width-0 hero-skel">
          <v-skeleton-loader type="text" width="140" height="17" class="mb-1" />
          <v-skeleton-loader type="text" width="320" height="41" />
          <v-skeleton-loader type="text" width="220" height="24" class="mt-1" />
          <v-skeleton-loader
            type="text"
            width="180"
            height="36"
            class="mt-4"
            style="border-radius: 9999px"
          />
        </div>
      </div>
      <div v-else-if="hasContent" class="hero-body">
        <!-- Whichever of the two the hero is currently showing: the
         - artwork of something playing opens Now Playing (see coverTo),
         - and the "nothing playing, here's your most recent album"
         - fallback keeps AlbumCard.vue's/SongRow.vue's own "click the
         - artwork to play" affordance. Either way it is a shortcut for
         - something already reachable next to it — the play button, or the
         - player bar's own artwork — never the only way there. -->
        <cover-art
          :cover-art-id="coverId"
          :image-url="imageUrl"
          :size="132"
          class="hero-cover cover-shadow hero-cover--clickable"
          @click="onCoverClick"
        />
        <div class="hero-info min-width-0">
          <div class="eyebrow-label mb-1">{{ eyebrow }}</div>
          <h1 class="detail-title hero-title text-truncate">
            <router-link v-if="titleTo" :to="titleTo" class="hero-title-link">{{
              title
            }}</router-link>
            <template v-else>{{ title }}</template>
          </h1>
          <div class="hero-subtitle text-truncate">
            <template v-if="artistName">
              <router-link
                v-if="artistId"
                :to="`/artists/${artistId}`"
                class="hero-subtitle-link"
                >{{ artistName }}</router-link
              >
              <span v-else>{{ artistName }}</span>
              <template v-if="albumName">
                ·
                <router-link v-if="albumId" :to="`/albums/${albumId}`" class="hero-subtitle-link">{{
                  albumName
                }}</router-link>
                <span v-else>{{ albumName }}</span>
              </template>
            </template>
            <template v-else>{{ subtitle }}</template>
          </div>
          <div class="hero-actions mt-4">
            <v-btn
              color="primary"
              :prepend-icon="isPlayingThis ? 'mdi-pause' : 'mdi-play'"
              rounded="pill"
              @click="$emit('play')"
            >
              {{ isPlayingThis ? $t('home.paused') : $t('home.keepListening') }}
            </v-btn>
            <!-- Secondary on purpose: the pill above is what this band is
             - for. Only shown when the hero is a *song* (the seed a mix is
             - built from) and the server can build one at all — see
             - HomeView.vue's heroCanStartRadio. -->
            <v-btn
              v-if="canStartRadio"
              prepend-icon="mdi-radio-tower"
              rounded="pill"
              color="primary"
              :loading="radioLoading"
              @click="$emit('song-radio')"
            >
              {{ $t('library.songRadio') }}
            </v-btn>
          </div>
        </div>
      </div>
      <div v-else class="hero-body">
        <div class="hero-info">
          <h1 class="detail-title hero-title">{{ $t('home.readyToPlay') }}</h1>
          <div class="hero-subtitle">{{ $t('home.nothingHeardYet') }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import { useLibraryStore } from '@/stores/library'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'

export default {
  name: 'HeroBand',
  components: { CoverArt },
  props: {
    greeting: { type: String, required: true },
    coverId: { type: String as PropType<string | null>, default: null },
    imageUrl: { type: String as PropType<string | null>, default: null },
    eyebrow: { type: String, default: '' },
    title: { type: String, default: '' },
    // Route for the title itself — only meaningful when `title` names an
    // album (the "nothing playing, here's your most recent album" fallback
    // state; see HomeView.vue's heroTitle/heroTitleTo). When a song is
    // playing, `title` is the *song's* name instead, which has no page of
    // its own in this app to link to.
    titleTo: { type: String as PropType<string | null>, default: null },
    // Where clicking the artwork goes, when it leads anywhere: Now Playing
    // while something is actually playing. Null in the "nothing playing,
    // here's your most recent album" state, where the artwork keeps its
    // older meaning and starts that album — Now Playing would have nothing
    // to show there, and the artwork on screen is a suggestion rather than
    // something already loaded. HomeView.vue decides which state it is in,
    // same division of labour as titleTo above.
    coverTo: { type: String as PropType<string | null>, default: null },
    // Plain-text-only fallback subtitle (radio's "Internet Radio" label) —
    // used only when neither artistName nor albumName is given below.
    subtitle: { type: String, default: '' },
    // Split out from a single formatted "Artist · Album" string (the
    // previous shape of `subtitle`) so each half can link to its own page,
    // same as everywhere else in the library (AlbumCard.vue, DetailHeader
    // consumers, ...) — a null *Id with a non-null name still renders the
    // name as plain text instead of silently dropping it.
    artistName: { type: String as PropType<string | null>, default: null },
    artistId: { type: String as PropType<string | null>, default: null },
    albumName: { type: String as PropType<string | null>, default: null },
    albumId: { type: String as PropType<string | null>, default: null },
    isPlayingThis: { type: Boolean, default: false },
    hasContent: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    // Whether a Song Radio can be built from whatever the hero is showing
    // right now — the decision itself is HomeView.vue's (it owns both the
    // seed song and the server capability), this component only renders
    // the button or doesn't.
    canStartRadio: { type: Boolean, default: false },
    radioLoading: { type: Boolean, default: false },
  },
  emits: ['play', 'song-radio'],
  data() {
    return { backdrop: createBackdropLayers() }
  },
  computed: {
    backdropUrl(): string | null {
      if (this.coverId) return useLibraryStore().client().coverArtUrl(this.coverId, 300)
      return this.imageUrl
    },
  },
  methods: {
    onCoverClick() {
      if (this.coverTo) this.$router.push(this.coverTo)
      else this.$emit('play')
    },
  },
  watch: {
    // immediate — the first hero should fade in from nothing rather than
    // waiting for a *second* one before the backdrop ever appears.
    backdropUrl: {
      immediate: true,
      handler(url: string | null) {
        showBackdrop(this.backdrop, url)
      },
    },
  },
}
</script>

<style scoped>
.hero-actions {
  display: flex;
  align-items: center;
  /* Wraps rather than squeezing both pills onto one line on a narrow
   * window — the band's own min-height already accommodates a second row. */
  flex-wrap: wrap;
  gap: 8px;
}

.hero-band {
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  margin-bottom: 40px;
  min-height: 220px;
  isolation: isolate;
}

.hero-backdrop {
  position: absolute;
  inset: -20px;
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.6);
  transform: scale(1.15);
  /* Two stacked instances of this, only one of them --active at a time —
   * this opacity transition is the crossfade itself. Same 0.6s as
   * DetailHeader.vue and NowPlayingView.vue, so every backdrop in the app
   * fades at one speed (and a song change, which updates two of them at
   * once, stays in step). */
  opacity: 0;
  transition: opacity 0.6s ease;
}

.hero-backdrop--active {
  opacity: 1;
}

.hero-scrim {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94) 0%,
      rgba(18, 20, 28, 0.72) 45%,
      rgba(245, 169, 78, 0.22) 100%
    ),
    linear-gradient(to top, rgba(18, 20, 28, 0.6), transparent 60%);
}

.hero-content {
  position: relative;
  padding: 32px 36px;
}

.hero-greeting {
  font-family: Georgia, 'Iowan Old Style', 'Palatino Linotype', serif;
  font-style: italic;
  font-size: 1.05rem;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 20px;
}

.hero-body {
  display: flex;
  align-items: center;
  gap: 24px;
}

.hero-cover {
  flex-shrink: 0;
}

.hero-cover--clickable {
  cursor: pointer;
}

.hero-subtitle {
  color: rgba(255, 255, 255, 0.65);
  margin-top: 4px;
}

.hero-title-link,
.hero-subtitle-link {
  color: inherit;
  text-decoration: none;
}

.hero-title-link:hover,
.hero-subtitle-link:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}

.min-width-0 {
  min-width: 0;
}

/* v-skeleton-loader's bones ignore the component's own width/height props
 * (fixed CSS heights + margin baked in) — those props only size the outer
 * wrapper. Forcing each bone to fill its wrapper exactly, combined with
 * heights computed from the real typography (eyebrow-label 17px,
 * detail-title 41px, hero-subtitle 24px, the button's 36px), is what keeps
 * the hero band's height identical between loading and loaded — nothing
 * below it jumps once the real content swaps in. */
.hero-skel :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
