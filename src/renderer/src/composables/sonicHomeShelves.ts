import { defineComponent } from 'vue'
import { emitter } from '@/emitter'
import { useAudioMuseStore } from '@/stores/audiomuse'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { getSonicMoods, sonicMix } from '@/services/connect/audiomuse'
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

/** Options-API mixin: Home's two AudioMuse-AI rows, shared by the desktop
 * and the phone page like homeShelvesMixin. Both stay away without
 * AudioMuse. */
export const sonicHomeShelvesMixin = defineComponent({
  data() {
    return {
      soundsLikeYouSongs: [] as Song[],
      loadingSoundsLikeYou: false,
      sonicMoods: [] as Mood[],
      // The mood whose mix is being fetched, for its button's spinner.
      moodLoading: null as Mood | null,
    }
  },
  computed: {
    audiomuseAvailable(): boolean {
      return useAudioMuseStore().available
    },
    mostPlayed(): Song[] {
      return useLibraryStore().mostPlayedSongs
    },
    /** The mood the queue was started from, while it is what plays.
     * Autoplay carrying on from it still counts: it continues from the
     * mix's own songs. */
    moodPlaying(): Mood | null {
      const playback = usePlaybackStore()
      if (playback.radioStation || playback.preview || !playback.currentSong) return null
      return (playback.moodMix as Mood | null) ?? null
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
        if (available && !this.sonicMoods.length) void this.loadMoods()
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
    async playMood(mood: Mood) {
      if (this.moodLoading) return
      this.moodLoading = mood
      try {
        await usePlaybackStore().startMoodMix(mood)
      } catch (error) {
        console.error('[home] mood mix failed:', error)
        emitter.emit('toast', {
          level: 'error',
          title: this.$t(`home.moods.${mood}`),
          message: this.$t('home.moodMixError'),
        })
      } finally {
        this.moodLoading = null
      }
    },
  },
})
