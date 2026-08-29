<template>
  <div
    class="song-info d-flex align-center"
    style="cursor: pointer"
    @click="hasPlayable && $router.push('/now-playing')"
  >
    <cover-art
      v-if="currentSong"
      :cover-art-id="currentSong.coverArtId"
      :size="48"
      class="cover mr-3"
    />
    <cover-art
      v-else-if="playbackStore.radioStation"
      :image-url="radioFaviconSrc"
      :size="48"
      fallback-icon="mdi-radio"
      class="cover mr-3"
    />
    <div class="min-width-0">
      <div class="text-body-medium text-truncate">
        {{ currentSong?.title ?? playbackStore.radioStation?.name ?? $t('player.nothingPlaying') }}
      </div>
      <router-link
        v-if="currentSong"
        :to="`/artists/${currentSong.artistId}`"
        class="text-body-small text-medium-emphasis text-truncate artist-link"
        @click.stop
      >
        {{ currentSong.artist }}
      </router-link>
      <div v-else class="text-body-small text-medium-emphasis text-truncate" />
    </div>
    <v-btn
      v-if="currentSong && authStore.capabilities.favorites"
      style="margin-inline: 8px"
      :icon="currentSong.starred ? 'mdi-heart' : 'mdi-heart-outline'"
      :color="currentSong.starred ? 'primary' : undefined"
      :disabled="starringInFlight"
      variant="text"
      density="comfortable"
      @click.stop="toggleStar"
    />
  </div>
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import { useAuthStore } from '@/stores/auth'
import { radioFaviconUrl } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'

export default {
  name: 'SongInfo',
  components: { CoverArt },
  data() {
    return {
      starringInFlight: false,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    authStore() {
      return useAuthStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    // 96, not 48 (the box's actual CSS size) — a favicon this small still
    // benefits from headroom on a high-DPI display, and the source is
    // free to just be smaller than that if that's all the station's
    // homepage actually declares (see routes/radio.py's _select()).
    radioFaviconSrc(): string | null {
      const homePageUrl = this.playbackStore.radioStation?.homePageUrl
      if (!homePageUrl) return null
      const auth = useAuthStore()
      return radioFaviconUrl(auth.apiUrl, auth.connectToken, homePageUrl, 96)
    },
    hasPlayable() {
      return this.currentSong != null || this.playbackStore.radioStation != null
    },
  },
  methods: {
    async toggleStar() {
      if (!this.currentSong || this.starringInFlight) return
      this.starringInFlight = true
      const song = this.currentSong
      const wasStarred = song.starred
      try {
        await useLibraryStore().toggleStar({ id: song.id, starred: wasStarred })
        // Flip the captured song, not this.currentSong — the song that
        // was actually playing might have advanced during the round-trip.
        song.starred = !wasStarred
      } finally {
        this.starringInFlight = false
      }
    },
  },
}
</script>

<style scoped>
/* Fixed width, hugging its own grid cell's start edge — see
 * PlayerBar.vue's own .player-bar__row comment for why this and
 * PlayerToolbar.vue's root share an identical track width instead of each
 * being sized to their own content. */
.song-info {
  width: 300px;
  justify-self: start;
}

.cover {
  flex-shrink: 0;
}

/* Block, not the anchor's default inline — text-truncate (overflow/
 * white-space/ellipsis) needs a constrained box to truncate against,
 * which an inline element sitting in normal block flow doesn't have here
 * (this row isn't itself a flex item, see .min-width-0 above it). */
.artist-link {
  display: block;
  text-decoration: none;
}

.artist-link:hover {
  color: rgb(var(--v-theme-primary));
}

/* Without min-width: 0, a flex item refuses to shrink below its content's
 * natural width by default — the title/artist text wouldn't truncate at
 * all, just push the star button (and this whole row) wider instead. */
.min-width-0 {
  min-width: 0;
}
</style>
