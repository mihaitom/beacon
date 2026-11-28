import { defineComponent } from 'vue'
import { emitter } from '@/emitter'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { getSonicMoods, getSonicThemes, sonicMix } from '@/services/connect/audiomuse'
import { shuffled } from '@/services/shuffle'
import type { Song } from '@/types/library'

// How many of the most played songs one "Sounds like you" draw
// blends. All fifteen would average out into the library's middle; a few
// keep it recognisably yours, and Reroll picks another few.
const SEEDS_PER_DRAW = 5
const SOUNDS_LIKE_YOU_LENGTH = 30

/** The moods Home offers, in this order. AudioMuse names its own; one this
 * list does not know has no label to show and is left out. */
export const MOODS = ['happy', 'relaxed', 'party', 'danceable', 'sad', 'aggressive'] as const
export type Mood = (typeof MOODS)[number]

/** Home's two rows of mix tiles: AudioMuse's moods, and what the lyrics are
 * about. */
export type HomeMixKind = 'mood' | 'theme'

export interface HomeMixTile {
  kind: HomeMixKind
  item: string
}

/** How the playback store remembers which tile started the queue. */
export function homeMixKey(kind: HomeMixKind, item: string): string {
  return `${kind}:${item}`
}

/** Options-API mixin: Home's AudioMuse-AI rows ("Sounds like you", moods,
 * themes), shared by the desktop and the phone page like homeShelvesMixin.
 * All of them stay away without AudioMuse. */
export const sonicHomeShelvesMixin = defineComponent({
  data() {
    return {
      soundsLikeYouSongs: [] as Song[],
      loadingSoundsLikeYou: false,
      sonicMoods: [] as Mood[],
      // In AudioMuse's order, which is Beacon's (connect's THEMES).
      sonicThemes: [] as string[],
      // The tile whose mix is being fetched (homeMixKey()), for its spinner.
      homeMixLoading: null as string | null,
    }
  },
  computed: {
    audiomuseAvailable(): boolean {
      return useAudioMuseStore().available
    },
    mostPlayed(): Song[] {
      return useLibraryStore().mostPlayedSongs
    },
    /** The tile the queue was started from (homeMixKey()), while it is
     * what plays. Autoplay carrying on from it still counts: it continues
     * from the mix's own songs. */
    homeMixPlaying(): string | null {
      const playback = usePlaybackStore()
      if (playback.radioStation || playback.preview || !playback.currentSong) return null
      return playback.homeMix
    },
    /** The moods, then the themes, as one section's tiles. */
    homeMixTiles(): HomeMixTile[] {
      return [
        ...this.sonicMoods.map((item) => ({ kind: 'mood' as const, item })),
        ...this.sonicThemes.map((item) => ({ kind: 'theme' as const, item })),
      ]
    },
    soundsLikeYouReady(): boolean {
      return this.audiomuseAvailable && this.mostPlayed.length > 0
    },
  },
  watch: {
    // Both wait for AudioMuse's status, and the shelf for the catalogue
    // that knows the play counts; either can come second.
    soundsLikeYouReady: {
      handler(ready: boolean) {
        if (ready && !this.soundsLikeYouSongs.length) void this.loadSoundsLikeYou()
      },
      immediate: true,
    },
    audiomuseAvailable: {
      handler(available: boolean) {
        if (!available) return
        if (!this.sonicMoods.length) void this.loadMoods()
        if (!this.sonicThemes.length) void this.loadThemes()
      },
      immediate: true,
    },
  },
  created() {
    void useAudioMuseStore().ensure()
  },
  methods: {
    async loadSoundsLikeYou() {
      const mostPlayed = this.mostPlayed
      if (!mostPlayed.length) return
      this.loadingSoundsLikeYou = true
      try {
        this.soundsLikeYouSongs = await sonicMix({
          method: 'blend',
          add: shuffled(mostPlayed)
            .slice(0, SEEDS_PER_DRAW)
            .map((song) => ({ id: song.id })),
          n: SOUNDS_LIKE_YOU_LENGTH,
          // Top songs is its own row already.
          exclude: mostPlayed.map((song) => song.id),
        })
      } catch (error) {
        console.warn('[home] AudioMuse "sounds like you" failed:', error)
        this.soundsLikeYouSongs = []
      } finally {
        this.loadingSoundsLikeYou = false
      }
    },
    async loadMoods() {
      try {
        const known = new Set(await getSonicMoods())
        this.sonicMoods = MOODS.filter((mood) => known.has(mood))
      } catch (error) {
        console.warn('[home] AudioMuse moods failed:', error)
      }
    },
    async loadThemes() {
      try {
        this.sonicThemes = await getSonicThemes()
      } catch (error) {
        // AudioMuse without its lyrics analysis has no themes to offer.
        console.warn('[home] AudioMuse themes failed:', error)
      }
    },
    async playHomeMix(kind: HomeMixKind, item: string) {
      if (this.homeMixLoading) return
      this.homeMixLoading = homeMixKey(kind, item)
      const playback = usePlaybackStore()
      try {
        await (kind === 'mood' ? playback.startMoodMix(item) : playback.startThemeMix(item))
      } catch (error) {
        console.error(`[home] ${kind} mix failed:`, error)
        emitter.emit('toast', {
          level: 'error',
          title: this.$t(`home.${kind}s.${item}`),
          message: this.$t('home.homeMixError'),
        })
      } finally {
        this.homeMixLoading = null
      }
    },
  },
})
