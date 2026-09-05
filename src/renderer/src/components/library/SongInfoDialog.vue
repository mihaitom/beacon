<template>
  <v-dialog v-model="visible" max-width="640" scrollable class="song-info">
    <v-card v-if="song" class="song-info__card">
      <!-- The same lit-artwork header every album, artist and playlist page
         - opens with (DetailHeader.vue), at dialog scale: blurred cover
         - behind a scrim, amber eyebrow, serif title. This used to be a
         - plain v-card-title with a 56px thumbnail, which read as a stock
         - Material dialog that happened to be shown by this app rather than
         - as a part of it. -->
      <header class="song-info__hero">
        <div
          v-if="backdropUrl"
          class="song-info__backdrop"
          :style="{ backgroundImage: `url(${backdropUrl})` }"
        />
        <!-- Drawn whether or not there is a backdrop behind it: on a track
           - with no artwork the gradient alone is still the header, rather
           - than the hero collapsing into a bare surface. -->
        <div class="song-info__scrim" />
        <v-btn
          class="song-info__close"
          icon="mdi-close"
          variant="text"
          density="comfortable"
          :title="$t('common.close')"
          @click="visible = false"
        />
        <div class="song-info__hero-body">
          <cover-art
            :cover-art-id="song.coverArtId"
            :size="88"
            class="song-info__art cover-shadow"
          />
          <div class="song-info__heading">
            <div v-if="song.album" class="eyebrow-label song-info__eyebrow">{{ song.album }}</div>
            <h2 class="display-title song-info__title">{{ song.title }}</h2>
            <p v-if="song.artist" class="song-info__subtitle">{{ song.artist }}</p>
          </div>
        </div>
      </header>

      <v-card-text class="song-info__body">
        <div v-if="loading" class="song-info__state">
          <v-progress-circular indeterminate size="28" width="2" color="primary" />
        </div>
        <p v-else-if="error" class="song-info__state song-info__state--text">
          {{ $t('songInfo.error') }}
        </p>
        <p v-else-if="!sections.length" class="song-info__state song-info__state--text">
          {{ $t('songInfo.empty') }}
        </p>
        <template v-else>
          <section v-for="group in sections" :key="group.titleKey" class="song-info__group">
            <h3 class="eyebrow-label song-info__group-title">{{ $t(group.titleKey) }}</h3>
            <dl class="song-info__rows">
              <template v-for="row in group.rows" :key="row.labelKey">
                <dt class="song-info__label">{{ $t(row.labelKey) }}</dt>
                <!-- Selectable, unlike the rest of the app's rows: a file
                   - path or a MusicBrainz id is here to be copied out, and
                   - those same rows are set in a monospaced face so the
                   - reader can tell an l from a 1 while doing it. -->
                <dd
                  class="song-info__value"
                  :class="{ 'song-info__value--code': isCode(row.labelKey) }"
                >
                  {{ row.value }}
                </dd>
              </template>
            </dl>
          </section>
        </template>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
// Everything the media server holds about one track. Mounted once in
// App.vue and opened over the emitter, same as ArtworkLightbox.vue - see
// types/events.ts's showSongInfo for why.
//
// The fields are fetched when it opens rather than read off the Song the
// row already has: that model deliberately keeps only what the lists need
// (see subsonic/types.ts's RawSongDetail), and this is the one place that
// wants the rest.
import CoverArt from './CoverArt.vue'
import { emitter } from '@/emitter'
import { useLibraryStore } from '@/stores/library'
import { songDetailSections, type SongDetailSection } from '@/services/library/songDetails'
import type { Song } from '@/types/library'

// The rows whose value is an identifier rather than prose. Named by their
// label key rather than by their section, because that is what they
// actually have in common: the ISRC list and the path are the same kind of
// value even though they sit in two different sections.
const CODE_ROWS = new Set(['songInfo.path', 'songInfo.musicBrainzId', 'songInfo.isrc'])

export default {
  name: 'SongInfoDialog',
  components: { CoverArt },
  data() {
    return {
      visible: false,
      // Kept while the dialog fades out rather than cleared with `visible`,
      // same as ArtworkLightbox.vue - blanking it on the same tick empties
      // the sheet that is still on screen.
      song: null as Song | null,
      sections: [] as SongDetailSection[],
      loading: false,
      error: false,
      listener: null as ((song: Song) => void) | null,
    }
  },
  computed: {
    /** The artwork behind the header. 300px like every other backdrop in
     * the app (see DetailHeader.vue): it is blurred past recognition, so a
     * larger fetch would only cost bytes - and asking for a size the rest
     * of the app already asks for keeps it a cache hit rather than a
     * fifth stored resolution of the same cover. */
    backdropUrl(): string | null {
      if (!this.song?.coverArtId) return null
      return useLibraryStore().client().coverArtUrl(this.song.coverArtId, 300)
    },
  },
  mounted() {
    this.listener = (song: Song) => {
      this.song = song
      this.visible = true
      void this.load(song)
    }
    emitter.on('showSongInfo', this.listener)
  },
  beforeUnmount() {
    if (this.listener) emitter.off('showSongInfo', this.listener)
  },
  methods: {
    isCode(labelKey: string): boolean {
      return CODE_ROWS.has(labelKey)
    },
    async load(song: Song): Promise<void> {
      this.loading = true
      this.error = false
      this.sections = []
      try {
        const detail = await useLibraryStore().client().getSongDetails(song.id)
        // A second open while the first request was still running would
        // otherwise paint the wrong track's fields into the dialog.
        if (this.song?.id !== song.id) return
        this.sections = songDetailSections(detail, this.$i18n.locale)
      } catch {
        if (this.song?.id !== song.id) return
        this.error = true
      } finally {
        if (this.song?.id === song.id) this.loading = false
      }
    },
  },
}
</script>

<style scoped>
.song-info__card {
  /* Short enough to leave the player bar visible behind it, same as the
   * privacy sheet - this is something read next to the app, not instead
   * of it. */
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  /* Same 16px as DetailHeader's own frame, and clipped: the hero's
   * backdrop is a blurred image bleeding past its own box, which without
   * this paints over the card's rounded corners. */
  border-radius: 16px;
  overflow: hidden;
}

.song-info__card :deep(.v-card-text) {
  overflow-y: auto;
}

/* ── Header ─────────────────────────────────────────────────────────── */

.song-info__hero {
  position: relative;
  flex: 0 0 auto;
  isolation: isolate;
  overflow: hidden;
}

/* Inset past its own edges and scaled up, so the blur has real image to
 * work with at the borders instead of fading into the box's transparent
 * edge - identical treatment to DetailHeader.vue and HeroBand.vue. */
.song-info__backdrop {
  position: absolute;
  inset: -20px;
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
}

.song-info__scrim {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94) 0%,
      rgba(18, 20, 28, 0.74) 48%,
      rgba(245, 169, 78, 0.18) 100%
    ),
    linear-gradient(to bottom, transparent 55%, rgba(18, 20, 28, 0.55));
}

.song-info__close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
}

.song-info__hero-body {
  position: relative;
  display: flex;
  align-items: center;
  gap: 20px;
  /* Right side kept clear of the close button above it. */
  padding: 24px 56px 24px 24px;
}

.song-info__art {
  flex-shrink: 0;
}

.song-info__heading {
  flex: 1 1 auto;
  min-width: 0;
}

.song-info__eyebrow {
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Two lines rather than one: track titles run long ("... - 2011 Remaster"),
 * and this is the one place in the app whose entire subject is that one
 * title. Beyond two it truncates rather than pushing the artwork's row
 * taller than the artwork. */
.song-info__title {
  font-size: 1.4rem;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.song-info__subtitle {
  margin: 6px 0 0;
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.72);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Fields ─────────────────────────────────────────────────────────── */

.song-info__body {
  padding: 20px 24px 24px;
}

.song-info__state {
  display: flex;
  justify-content: center;
  padding: 32px 0;
}

.song-info__state--text {
  max-width: 34ch;
  margin: 0 auto;
  font-size: 0.8125rem;
  text-align: center;
  color: rgba(255, 255, 255, 0.6);
}

.song-info__group + .song-info__group {
  margin-top: 22px;
}

/* The app's amber eyebrow, carried to the end of the sheet by a hairline -
 * the same "small lit mark plus a label" language as .section-title on
 * every page, at the scale a dialog wants. */
.song-info__group-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.song-info__group-title::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--beacon-hairline);
}

/* Labels sized to the longest of them, values taking the rest - a table
 * would line the columns up across all four sections, which is wrong: each
 * section's labels are their own set.
 *
 * The whole set sits on one panel, the same bordered surface Settings and
 * the station cards use, so a section reads as one block of facts rather
 * than as loose text on the dialog's floor. */
.song-info__rows {
  display: grid;
  grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr);
  margin: 0;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}

.song-info__label,
.song-info__value {
  padding: 9px 14px;
  font-size: 0.8125rem;
  line-height: 1.5;
  /* Neutral rather than the amber --beacon-hairline the panel's own border
   * uses: there is one of these between every pair of rows, and at a dozen
   * repeats the tint stops reading as a hairline and starts reading as
   * stripes. */
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

/* dt and dd of the first row, which have the panel's own border above them
 * already. */
.song-info__rows > :nth-child(-n + 2) {
  border-top: none;
}

.song-info__label {
  color: rgba(255, 255, 255, 0.55);
}

.song-info__value {
  margin: 0;
  min-width: 0;
  /* A file path has no spaces to break at and would otherwise push the
   * dialog wider than the window. */
  overflow-wrap: anywhere;
  user-select: text;
}

.song-info__value--code {
  font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.82);
}

/* On a phone-width window the dialog is nearly the full screen, and 88px
 * of artwork next to two columns of fields leaves neither enough room. */
@media (max-width: 480px) {
  .song-info__hero-body {
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding: 20px 20px 18px;
  }

  .song-info__body {
    padding: 16px 20px 20px;
  }

  .song-info__rows {
    grid-template-columns: minmax(0, 1fr);
  }

  .song-info__label {
    padding-bottom: 0;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  /* One column means every cell is its own row, so the separator has to be
   * drawn between *pairs* rather than between cells - the label keeps its
   * line, the value under it gives its own up. */
  .song-info__value {
    padding-top: 2px;
    border-top: none;
  }

  .song-info__rows > :nth-child(-n + 2) {
    border-top: none;
  }
}
</style>
