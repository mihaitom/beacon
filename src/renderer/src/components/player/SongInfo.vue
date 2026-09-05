<template>
  <!-- Only the parts that actually go somewhere look like they do. The
   - whole block used to carry a pointer cursor unconditionally: with
   - nothing playing it pointed at a click that does nothing, and on radio
   - it made two labels look like links to a page that does not exist (a
   - station has no page of its own — see the plain text below). What is
   - left clickable is the artwork and the space around it, which opens Now
   - Playing, plus a song's own artist link. -->
  <div
    class="song-info"
    :class="{ 'song-info--clickable': hasPlayable }"
    @click="hasPlayable && $router.push('/now-playing')"
  >
    <cover-art v-if="currentSong" :cover-art-id="currentSong.coverArtId" :size="48" class="cover" />
    <cover-art
      v-else-if="playbackStore.radioStation"
      :radio-favicon="radioFavicon"
      :size="48"
      fallback-icon="mdi-radio"
      class="cover"
    />
    <!-- A song's labels stay part of the block's own click (its title is
     - one more way to reach Now Playing, and its artist is a real link).
     - Radio's are text and nothing else: neither line has anywhere of its
     - own to lead, so neither pretends to. -->
    <div
      class="song-info__labels"
      :class="{ 'song-info__labels--inert': !currentSong }"
      @click="onLabelsClick"
    >
      <div class="text-body-medium">
        {{
          currentSong?.title ??
          playbackStore.radioNowPlaying ??
          playbackStore.radioStation?.name ??
          $t('player.nothingPlaying')
        }}
      </div>
      <router-link
        v-if="currentSong"
        :to="`/artists/${currentSong.artistId}`"
        class="text-body-small text-medium-emphasis artist-link"
        @click.stop
      >
        {{ currentSong.artist }}
      </router-link>
      <!-- Station name, not the ICY tag — swapped with the top label above
       - so the tag (what's actually playing right now) is the prominent
       - one and the station is secondary, same as NowPlayingView.vue's own
       - swap for consistency. Only shown once there's a tag to go with it
       - (mirrors the top label's own fallback chain above); with no tag the
       - station name already sits up there, so repeating it here would
       - just be noise. -->
      <div v-else-if="playbackStore.radioNowPlaying" class="text-body-small text-medium-emphasis">
        {{ playbackStore.radioStation?.name }}
      </div>
      <div v-else class="text-body-small text-medium-emphasis" />
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
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
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
    radioFavicon(): RadioFaviconRequest | null {
      const station = this.playbackStore.radioStation
      if (!station?.homePageUrl && !station?.favicon) return null
      return radioFaviconRequest(station.homePageUrl ?? '', 96, station.favicon ?? '')
    },
    hasPlayable() {
      return this.currentSong != null || this.playbackStore.radioStation != null
    },
  },
  methods: {
    /** Swallows the click on radio's (and the idle placeholder's) labels,
     * so what they do matches what they look like. A song's labels fall
     * through to the block's own handler as before. */
    onLabelsClick(event: MouseEvent) {
      if (!this.currentSong) event.stopPropagation()
    },
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
/* Fills its grid track rather than sitting at a fixed 300px inside it.
 *
 * The two flanks of PlayerBar.vue's row share one width, whichever of the
 * two needs more room in the current state (see .player-bar__row's own
 * comment) — so whenever the toolbar is the wider one, this sat at 300px
 * in a 434px track with the difference simply unused, while the text next
 * to it truncated. Radio shows that plainest: a station's ICY metadata
 * arrives as a single "Artist - Title" string with no artist line to split
 * it across, so all of it competes for the top line's width.
 *
 * Nothing about the centering changes: the track is exactly as wide as it
 * was, this just uses all of it. min-width: 0 because a grid item's
 * automatic minimum is its content, which would otherwise stop the text
 * inside from ever truncating. */
.song-info {
  display: flex;
  align-items: center;
  min-width: 0;
}

.song-info--clickable {
  cursor: pointer;
}

/* Text, not a control — the default cursor is the whole point. */
.song-info__labels--inert {
  cursor: default;
}

.cover {
  flex-shrink: 0;
}

/* Block, not the anchor's default inline — the ellipsis rule on
 * .song-info__labels' children needs a constrained box to truncate
 * against, which an inline element sitting in normal block flow doesn't
 * have here (this row isn't itself a flex item, see .song-info__labels
 * above it). */
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
.song-info__labels {
  min-width: 0;
}

/* Every line in the player bar clips: the bar is a fixed height, and a
 * radio station's ICY tag arrives as one long "Artist - Title" string. */
.song-info__labels > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cover {
  margin-right: 12px;
}
</style>
