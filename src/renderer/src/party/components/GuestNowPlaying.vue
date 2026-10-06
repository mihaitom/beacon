<template>
  <div class="guest-np" :class="{ 'guest-np--compact': compact }">
    <now-playing-backdrop
      :source="backdropSource"
      :is-artist="Boolean(snapshot?.backdrop)"
      :scrim-style="ambientStyle"
    />

    <!-- Same pill of toggles NowPlayingToolbar puts top right, plus the
     - guests' own one: the skip vote with its count. -->
    <div v-if="song || radio" class="guest-np__toolbar">
      <v-btn
        v-if="lyrics"
        icon="mdi-script-text-outline"
        :color="showLyrics ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('lyrics.title')"
        @click="toggle('showLyrics')"
      />
      <v-btn
        v-if="visualizerAvailable"
        icon="mdi-equalizer"
        :color="showVisualizer ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.toggleVisualizer')"
        @click="toggle('showVisualizer')"
      />
      <!-- The app's "next background" - each guest steps through the
       - artist's pictures on their own screen. -->
      <v-btn
        v-if="snapshot?.backdrop && snapshot.backdrop_count > 1"
        icon="mdi-wallpaper"
        variant="text"
        density="comfortable"
        :title="$t('nowPlaying.nextBackground')"
        @click="nextBackdrop"
      />
      <!-- Only with an artist background to switch to, as in the app:
       - without one the cover is all there is, so it stays. -->
      <v-btn
        v-if="snapshot?.backdrop"
        icon="mdi-album"
        :color="largeArtwork ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        :title="$t('partyGuest.largeArtwork')"
        @click="toggle('largeArtwork')"
      />
      <v-btn
        v-if="snapshot?.skip.enabled"
        prepend-icon="mdi-skip-next"
        :color="snapshot.skip.mine ? 'primary' : undefined"
        variant="text"
        density="comfortable"
        rounded="pill"
        :loading="skipping"
        :title="snapshot.skip.mine ? $t('partyGuest.voted') : $t('partyGuest.voteSkip')"
        :aria-label="snapshot.skip.mine ? $t('partyGuest.voted') : $t('partyGuest.voteSkip')"
        class="guest-np__skip"
        @click="toggleSkip"
      >
        {{ snapshot.skip.votes }}/{{ snapshot.skip.needed }}
      </v-btn>
    </div>

    <!-- The container-query host, like NowPlayingView's own stage. -->
    <div class="guest-np__stage">
      <div
        v-if="song || radio"
        class="guest-np__content"
        :class="{
          'guest-np__content--corner': !artworkLarge,
          'guest-np__content--split': lyricsShown,
        }"
      >
        <!-- On a phone this is NowPlayingStageMobile's flip card: the cover
         - (or the corner card) in front, the lyrics full-screen on its back.
         - On a larger screen it is display: contents and the two sit side
         - by side. -->
        <div class="guest-np__flip-card">
          <!-- Large: the artwork in the middle with the text under it. -->
          <div v-if="artworkLarge" class="guest-np__primary">
            <div class="guest-np__art-wrap">
              <div class="guest-np__art-glow" :style="{ background: glowColor }" />
              <img v-if="coverUrl" :src="coverUrl" alt="" class="guest-np__art" :class="artClass" />
              <div v-else class="guest-np__art guest-np__art--empty">
                <v-icon :icon="radio ? 'mdi-radio' : 'mdi-album'" size="64" />
              </div>
            </div>
            <div class="eyebrow-label">{{ eyebrow }}</div>
            <h1 class="detail-title guest-np__title">{{ title }}</h1>
            <div v-if="subtitle" class="text-title-large text-medium-emphasis">
              {{ subtitle }}
            </div>
            <div v-if="song?.album" class="text-body-medium text-medium-emphasis">
              {{ song.album }}
            </div>
            <v-chip
              v-if="song?.wished_by"
              size="small"
              variant="tonal"
              color="primary"
              prepend-icon="mdi-party-popper"
            >
              {{ $t('party.wishedBy', { name: song.wished_by }) }}
            </v-chip>
          </div>

          <!-- The default, as NowPlayingView with its artwork hidden: a glass
         - card in the bottom-left corner, so the backdrop is what the
         - screen is about. -->
          <div v-else class="guest-np__card guest-np__primary--corner">
            <img v-if="coverUrl" :src="coverUrl" alt="" class="guest-np__mini-art cover-shadow" />
            <div v-else class="guest-np__mini-art guest-np__art--empty">
              <v-icon :icon="radio ? 'mdi-radio' : 'mdi-album'" size="28" />
            </div>
            <div class="guest-np__info">
              <div class="eyebrow-label">{{ eyebrow }}</div>
              <h1 class="detail-title guest-np__title">{{ title }}</h1>
              <div v-if="subtitle" class="text-title-large text-medium-emphasis guest-np__artist">
                {{ subtitle }}
              </div>
              <div v-if="song?.album" class="text-body-medium text-medium-emphasis guest-np__album">
                {{ song.album }}
              </div>
              <div v-if="song?.wished_by" class="text-body-small guest-np__wish">
                <v-icon icon="mdi-party-popper" size="14" />
                {{ $t('party.wishedBy', { name: song.wished_by }) }}
              </div>
            </div>
          </div>

          <transition name="guest-np-lyrics">
            <div v-if="lyricsShown && lyrics" class="guest-np__lyrics">
              <lyrics-lines
                v-model:autoscroll-paused="autoscrollPaused"
                :lines="lyrics.lines"
                :synced="lyrics.synced"
                :position="store.position - lyrics.offset"
                variant="immersive"
                :song-key="lyrics.song_id"
              />
              <v-btn
                v-if="autoscrollPaused"
                icon="mdi-format-vertical-align-center"
                size="small"
                variant="text"
                color="primary"
                class="guest-np__resume"
                :title="$t('lyrics.resumeAutoscroll')"
                @click="autoscrollPaused = false"
              />
            </div>
          </transition>
        </div>
      </div>
      <span v-else class="text-medium-emphasis">{{ $t('partyGuest.nothingPlaying') }}</span>
    </div>

    <!-- Only while casting: connect analyses what the speakers play then.
     - Local playback keeps its analyser in the host's browser. -->
    <div v-if="visualizerActive" class="guest-np__visualizer">
      <visualizer-bars :sample="sampleBands" :color="visualizerColor" />
    </div>
  </div>
</template>

<script lang="ts">
import NowPlayingBackdrop from '@/components/now-playing/NowPlayingBackdrop.vue'
import LyricsLines from '@/components/lyrics/LyricsLines.vue'
import VisualizerBars from '@/components/player/VisualizerBars.vue'
import { resampleBands } from '@/services/visualizerBands'
import { extractDominantColor } from '@/services/colorExtractor'
import { visualizerBarColor } from '@/services/visualizerColor'
import {
  BACKDROP_URL,
  VISUALIZER_URL,
  type GuestLyrics,
  type GuestRadio,
  type GuestSnapshot,
  type GuestSong,
} from '../api'
import { usePartyGuestStore } from '../store'
import { guestErrorKey } from '../errors'

// The app's amber, as NowPlayingView falls back to it.
const FALLBACK_COLOR = '245, 169, 78'

type Preference = 'showLyrics' | 'showVisualizer' | 'largeArtwork'
const PREFERENCE_KEY = 'beacon_party_view'

function readPreferences(): Partial<Record<Preference, boolean>> {
  try {
    return JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function readPreference(name: Preference, fallback: boolean): boolean {
  return readPreferences()[name] ?? fallback
}

export default {
  name: 'GuestNowPlaying',
  components: { NowPlayingBackdrop, LyricsLines, VisualizerBars },
  props: {
    compact: { type: Boolean, default: false },
  },
  emits: ['notify'],
  data() {
    return {
      // The three toggles, remembered on this device like the app
      // remembers its own (see readPreference).
      showLyrics: readPreference('showLyrics', true),
      showVisualizer: readPreference('showVisualizer', true),
      largeArtwork: readPreference('largeArtwork', false),
      autoscrollPaused: false,
      skipping: false,
      coverColor: null as string | null,
      backdropColor: null as string | null,
      // Which of the artist's backgrounds this guest stepped to; null is
      // the host's.
      backdropIndex: null as number | null,
      bands: null as number[] | null,
      // Until connect's reading arrives, the logo gets the normal card.
      logoTransparent: false,
      visualizerEvents: null as EventSource | null,
    }
  },
  computed: {
    store() {
      return usePartyGuestStore()
    },
    snapshot(): GuestSnapshot | null {
      return this.store.snapshot
    },
    song(): GuestSong | null {
      return this.snapshot?.current_song ?? null
    },
    radio(): GuestRadio | null {
      return this.snapshot?.radio ?? null
    },
    lyrics(): GuestLyrics | null {
      const lyrics = this.store.currentLyrics
      return lyrics && lyrics.lines.length ? lyrics : null
    },
    lyricsShown(): boolean {
      return this.showLyrics && Boolean(this.lyrics)
    },
    /** As NowPlayingView's artworkHidden, the other way round: the corner
     * card is a choice only when there is an artist background to look at
     * instead - without one the large cover shows on its own. */
    artworkLarge(): boolean {
      return this.largeArtwork || !this.snapshot?.backdrop
    },
    eyebrow(): string {
      if (this.radio) return this.$t('home.radioEyebrow')
      return this.snapshot?.playing ? this.$t('home.nowPlaying') : this.$t('home.paused')
    },
    /** On radio as in the app (SongInfo.vue): the ICY title on top, the
     * station under it - or the station alone while it sends none. */
    title(): string {
      return this.song?.title ?? this.radio?.now_playing ?? this.radio?.name ?? ''
    },
    subtitle(): string | null {
      if (this.song) return this.song.artist
      return this.radio?.now_playing ? this.radio.name : null
    },
    /** Bars only exist while the host casts a song (see the template). */
    visualizerAvailable(): boolean {
      return Boolean(this.snapshot?.casting && this.song)
    },
    coverUrl(): string | null {
      return this.song?.cover ?? this.radio?.logo ?? null
    },
    /** NowPlayingArtwork's treatment: a station logo is fitted rather than
     * cropped, and one that floats on transparency gets no card around it. */
    artClass(): Record<string, boolean> {
      const logo = !this.song && Boolean(this.radio?.logo)
      return {
        'guest-np__art--logo': logo,
        'guest-np__art--transparent': logo && this.logoTransparent,
        'cover-shadow': !(logo && this.logoTransparent),
      }
    },
    backdropSource(): string | null {
      if (this.snapshot?.backdrop && this.song) {
        // Keyed by artist so a new artist's picture is a new URL; the host's
        // pick until this guest steps on.
        const artist = encodeURIComponent(this.song.artist ?? '')
        return this.backdropIndex === null
          ? `${BACKDROP_URL}?artist=${artist}`
          : `${BACKDROP_URL}?artist=${artist}&index=${this.backdropIndex}`
      }
      // A station logo is no backdrop, as in the app.
      return this.song?.cover ?? null
    },
    colorTriplet(): string {
      return this.coverColor ?? FALLBACK_COLOR
    },
    // Same recipe as NowPlayingView's ambientStyle and glowColor: the
    // artist background shows undimmed while the cover is in the corner -
    // that is what the corner is for - and darkened behind the large one.
    ambientStyle(): Record<string, string> {
      if (this.snapshot?.backdrop && !this.artworkLarge) return { background: 'none' }
      if (this.snapshot?.backdrop) return { background: 'rgba(18, 20, 28, 0.55)' }
      return {
        background: `radial-gradient(ellipse 65% 55% at 50% 32%, rgba(${this.colorTriplet}, 0.35), rgba(18, 20, 28, 0) 70%), rgba(18, 20, 28, 0.55)`,
      }
    },
    glowColor(): string {
      return `radial-gradient(circle, rgba(${this.colorTriplet}, 0.55) 0%, rgba(${this.colorTriplet}, 0) 70%)`
    },
    /** NowPlayingView's visualizerColor: the artist background's own
     * colour once there is one, the app's amber otherwise. */
    visualizerColor(): string {
      return visualizerBarColor(this.snapshot?.backdrop ? this.backdropColor : null)
    },
    visualizerActive(): boolean {
      return this.showVisualizer && this.visualizerAvailable && Boolean(this.snapshot?.playing)
    },
  },
  watch: {
    // The song's cover only: the app keeps its amber for a station, which
    // is also what keeps a dark logo readable against the glow.
    'song.cover': {
      immediate: true,
      handler(url: string | null | undefined) {
        this.coverColor = null
        if (url) void this.loadColor(url, 'coverColor')
      },
    },
    'radio.logo': {
      immediate: true,
      handler(url: string | null | undefined) {
        this.logoTransparent = false
        if (url) void this.loadLogoTransparency(url)
      },
    },
    // immediate: the picture already there when the page opens needs its
    // colour as much as the next one.
    backdropSource: {
      immediate: true,
      handler(url: string | null) {
        this.backdropColor = null
        if (url && this.snapshot?.backdrop) void this.loadColor(url, 'backdropColor')
      },
    },
    'song.artist'() {
      this.backdropIndex = null
    },
    // As in the app, the accent follows the bars: buttons, tabs and
    // highlights tint along with the picture while this view is up.
    visualizerColor: {
      immediate: true,
      handler(color: string) {
        this.applyPrimary(color)
      },
    },
    visualizerActive: {
      immediate: true,
      handler(active: boolean) {
        if (active) this.openVisualizer()
        else this.closeVisualizer()
      },
    },
  },
  beforeUnmount() {
    this.closeVisualizer()
    this.applyPrimary(FALLBACK_COLOR)
  },
  methods: {
    toggle(name: Preference) {
      this[name] = !this[name]
      try {
        localStorage.setItem(
          PREFERENCE_KEY,
          JSON.stringify({ ...readPreferences(), [name]: this[name] }),
        )
      } catch {
        // Not remembered, still switched for now.
      }
    },
    async loadColor(url: string, target: 'coverColor' | 'backdropColor') {
      const rgb = await extractDominantColor(url)
      // The song or the picture may have changed while this loaded.
      const current = target === 'coverColor' ? this.song?.cover : this.backdropSource
      if (url !== current) return
      this[target] = rgb ? rgb.join(', ') : null
    },
    /** connect measures the logo (routes/radio.py's _has_transparency) and
     * says so in a header an <img> cannot read; the image itself then comes
     * out of the browser's cache. */
    async loadLogoTransparency(url: string) {
      try {
        const response = await fetch(url, { credentials: 'same-origin' })
        if (url !== this.radio?.logo) return
        this.logoTransparent = response.headers.get('X-Has-Transparency') === 'true'
      } catch {
        // Shown with a card, as before its reading arrives.
      }
    },
    /** NowPlayingView's applyPrimary: through the theme object, so Vuetify
     * re-derives on-primary for the new colour. */
    applyPrimary(color: string) {
      const theme = this.$vuetify.theme
      const colors = theme.themes[theme.name]?.colors
      if (colors) colors.primary = `rgb(${color})`
    },
    nextBackdrop() {
      const count = this.snapshot?.backdrop_count ?? 0
      if (count < 2) return
      const current = this.backdropIndex ?? this.snapshot?.backdrop_index ?? 0
      this.backdropIndex = (current + 1) % count
    },
    openVisualizer() {
      if (this.visualizerEvents) return
      this.visualizerEvents = new EventSource(VISUALIZER_URL, { withCredentials: true })
      this.visualizerEvents.onmessage = (event: MessageEvent<string>) => {
        this.bands = (JSON.parse(event.data) as { bands: number[] }).bands
      }
    },
    sampleBands(): number[] | null {
      return resampleBands(this.bands)
    },
    closeVisualizer() {
      this.visualizerEvents?.close()
      this.visualizerEvents = null
      this.bands = null
    },
    async toggleSkip() {
      this.skipping = true
      try {
        await this.store.toggleSkip()
      } catch (error) {
        this.$emit('notify', this.$t(guestErrorKey(error)))
      } finally {
        this.skipping = false
      }
    },
  },
}
</script>

<style scoped>
.guest-np {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* NowPlayingToolbar's pill: icons on a translucent ground, so they stay
 * visible on a bright artist photo. */
.guest-np__toolbar {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(18, 20, 28, 0.55);
  backdrop-filter: blur(8px);
}

.guest-np--compact .guest-np__toolbar {
  top: 8px;
  right: 8px;
}

.guest-np__skip {
  font-variant-numeric: tabular-nums;
}

.guest-np__stage {
  position: relative;
  flex: 1;
  min-height: 0;
  container: guest-np-stage / size;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.guest-np--compact .guest-np__stage {
  padding: 64px 12px 16px;
}

.guest-np__content {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(24px, 4cqw, 80px);
}

/* As NowPlayingStageDesktop's --corner: the card bottom left, the lyrics
 * (if open) on the right. */
.guest-np__content--corner {
  align-items: flex-end;
  justify-content: space-between;
  /* Room for the card's own shadow, which the stage would clip. */
  padding-bottom: 24px;
}

.guest-np__primary {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  min-width: 0;
  flex-shrink: 1;
}

/* Sized against the stage, as the app's own artwork is. */
.guest-np__art-wrap {
  position: relative;
  width: min(52cqh, 50cqw, 520px);
  aspect-ratio: 1;
  margin-bottom: 12px;
}

/* NowPlayingStageMobile's artSize: measured to leave room for the text
 * under the artwork. */
.guest-np--compact .guest-np__art-wrap {
  width: clamp(88px, min(58cqh, 90cqw, calc(100cqh - 100px)), 480px);
}

/* Same halo as NowPlayingArtwork.vue's .now-playing__art-glow. */
.guest-np__art-glow {
  position: absolute;
  inset: -70px;
  border-radius: 50%;
  filter: blur(60px);
  transition: background 1.2s ease;
}

.guest-np__art {
  position: relative;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 4px;
}

.guest-np__art--logo {
  object-fit: contain;
  background: rgba(255, 255, 255, 0.06);
}

.guest-np__art--transparent {
  background: transparent;
}

.guest-np__art--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.4);
}

/* NowPlayingTrackPanels' corner panel: the glass behind the mini cover and
 * the text, so both stay readable on the artist background. */
.guest-np__card {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  min-width: 0;
  max-width: min(46cqw, 640px);
  padding: 16px 20px;
  border-radius: 18px;
  background: rgba(18, 20, 28, 0.5);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
}

.guest-np--compact .guest-np__card {
  max-width: none;
  gap: 12px;
  padding: 12px 14px;
}

/* NowPlayingTrackPanels' .now-playing__mini-art. */
.guest-np__mini-art {
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  border-radius: 8px;
  object-fit: cover;
}

.guest-np--compact .guest-np__mini-art {
  width: 56px;
  height: 56px;
  box-shadow: none;
}

.guest-np__info {
  min-width: 0;
}

.guest-np__info > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guest-np__title {
  font-size: clamp(1.1rem, min(2.3cqw, 9cqh), 2.75rem);
  line-height: 1.15;
  margin: 0;
  overflow-wrap: anywhere;
}

.guest-np__primary .guest-np__title {
  font-size: clamp(1.5rem, min(4cqw, 6cqh), 2.75rem);
}

.guest-np--compact .guest-np__card .guest-np__title {
  font-size: 1.15rem;
}

.guest-np--compact .guest-np__artist {
  font-size: 0.95rem !important;
}

.guest-np--compact .guest-np__album {
  font-size: 0.8rem !important;
}

.guest-np__wish {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  color: rgb(var(--v-theme-primary));
}

/* NowPlayingStageDesktop's .now-playing__lyrics: their own ground, since
 * the active line's glow alone is lost on a bright backdrop. */
/* A flex column, as .lyrics-panel is: LyricsLines' scroll area takes the
 * rest of it (flex: 1, min-height: 0) and scrolls inside. As a plain block
 * it grew to the whole text instead and was clipped, so nothing scrolled. */
.guest-np__lyrics {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: none;
  width: min(38cqw, 560px);
  height: 85cqh;
  border-radius: 18px;
  overflow: hidden;
  background: rgba(18, 20, 28, 0.62);
  backdrop-filter: blur(10px);
}

.guest-np__resume {
  position: absolute;
  right: 8px;
  bottom: 8px;
}

/* The app's visualizer row height (NowPlayingVisualizer.vue). */
.guest-np__visualizer {
  position: relative;
  height: 96px;
  flex-shrink: 0;
}

.guest-np--compact .guest-np__visualizer {
  height: 56px;
}

/* Side by side on a larger screen: the card is no box of its own. */
.guest-np__flip-card {
  display: contents;
}

/* ── Desktop: NowPlayingStageDesktop's flip ──
 * The same boundary as the app: where the artwork and the lyrics no longer
 * fit side by side, they become the two faces of one card. Not in the
 * corner layout - with the artwork in the corner there is nothing to turn
 * to, and the lyrics stay beside the card (as in the app). */
@container guest-np-stage (
  (max-aspect-ratio: 4/5) or ((max-width: 1560px) and (max-aspect-ratio: 3/2))
) {
  .guest-np__content--split:not(.guest-np__content--corner) {
    width: auto;
    gap: 0;
    perspective: 2000px;
  }

  .guest-np__content:not(.guest-np__content--corner) .guest-np__flip-card {
    display: block;
    position: relative;
    height: 100%;
    transform-style: preserve-3d;
    transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .guest-np__content--split:not(.guest-np__content--corner) .guest-np__flip-card {
    transform: rotateY(180deg);
  }

  .guest-np__content:not(.guest-np__content--corner) .guest-np__primary {
    height: 100%;
    justify-content: center;
    transform: rotateY(0deg);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  /* The back face takes the artwork's own box; its type is tuned to that
   * box, as in the app. */
  .guest-np__content:not(.guest-np__content--corner) .guest-np__lyrics {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    transform: rotateY(180deg);
    container-type: size;
    --lyrics-flip-font-size: clamp(0.95rem, min(6cqw, 8cqh), 1.9rem);
    --lyrics-flip-line-padding: 10px 20px;
  }

  .guest-np-lyrics-enter-active,
  .guest-np-lyrics-leave-active {
    transition: opacity 0.7s ease;
  }

  .guest-np-lyrics-enter-from,
  .guest-np-lyrics-leave-to {
    opacity: 0;
  }
}

/* ── Phone: NowPlayingStageMobile's flip card ── */

.guest-np--compact .guest-np__content {
  padding-bottom: 0;
}

.guest-np--compact .guest-np__flip-card {
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}

.guest-np--compact .guest-np__content--split .guest-np__flip-card {
  transform: rotateY(180deg);
}

/* An explicit identity rotation: Chromium only hides the back of this face
 * once it has a 3D transform of its own (see NowPlayingStageMobile). */
.guest-np--compact .guest-np__primary {
  height: 100%;
  justify-content: center;
  transform: rotateY(0deg);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

/* The corner card sits along the bottom, centred, and shrinks to what it
 * holds; a long label ellipsises inside it. */
.guest-np--compact .guest-np__content--corner .guest-np__flip-card {
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.guest-np--compact .guest-np__primary--corner {
  max-width: 100%;
  transform: rotateY(0deg);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

/* The back face fills the screen, dark in the middle where the active line
 * sits and fading out top and bottom so the backdrop shows through. */
.guest-np--compact .guest-np__lyrics {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0;
  backdrop-filter: none;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  transform: rotateY(180deg);
  container-type: size;
  --lyrics-flip-font-size: clamp(0.95rem, min(6cqw, 8cqh), 1.9rem);
  --lyrics-flip-line-padding: 10px 20px;
  background: linear-gradient(
    to bottom,
    rgba(18, 20, 28, 0.15) 0%,
    rgba(18, 20, 28, 0.6) 26%,
    rgba(18, 20, 28, 0.6) 74%,
    rgba(18, 20, 28, 0.15) 100%
  );
}

/* Vue keeps a leaving element as long as its own transition runs; the
 * rotation lives on the card, so an opacity fade of the same length gives
 * it one (see NowPlayingStageMobile). */
.guest-np--compact .guest-np-lyrics-enter-active,
.guest-np--compact .guest-np-lyrics-leave-active {
  transition: opacity 0.7s ease;
}

.guest-np--compact .guest-np-lyrics-enter-from,
.guest-np--compact .guest-np-lyrics-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .guest-np__art-glow,
  .guest-np--compact .guest-np__flip-card {
    transition: none;
  }
}
</style>
