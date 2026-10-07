<template>
  <waveform-bars
    :peaks="peaks"
    :model-value="modelValue"
    :duration="duration"
    :disabled="disabled"
    :buffered="buffered"
    :dimmed="dimmed"
    @update:model-value="$emit('update:modelValue', $event)"
    @end="$emit('end', $event)"
  />
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { getWaveform } from '@/services/connect/waveform'
import WaveformBars from './WaveformBars.vue'

/** The player's waveform seek bar: WaveformBars with the playing song's
 * peaks, fetched from connect. */
export default {
  name: 'SongWaveform',
  components: { WaveformBars },
  props: {
    // Mirrors v-slider's own prop/event contract (model-value + @end) so
    // this is a drop-in replacement — see PlayerBar.vue, whose
    // seekPreviewPosition/onSeekEnd logic doesn't need to change at all.
    // The rest are WaveformBars.vue's, passed through.
    modelValue: { type: Number, required: true },
    duration: { type: Number, required: true },
    disabled: { type: Boolean, default: false },
    buffered: { type: Number, default: 0 },
    dimmed: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'end'],
  data() {
    return {
      peaks: [] as number[],
      // Guards a rapid song change from racing two fetches — same pattern
      // as stores/lyrics.ts's inFlightSongId.
      fetchedSongId: null as string | null,
    }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    // Not the seek-value contract's concern, so read directly off the store
    // rather than as a prop. Radio has no stable id/seekable position.
    songId(): string | null {
      return this.playbackStore.radioStation ? null : (this.playbackStore.currentSong?.id ?? null)
    },
  },
  watch: {
    songId: {
      immediate: true,
      handler(id: string | null) {
        this.loadPeaks(id)
      },
    },
  },
  methods: {
    async loadPeaks(id: string | null, attempt = 0) {
      if (!id) {
        this.peaks = []
        this.fetchedSongId = null
        return
      }
      if (attempt === 0) {
        if (this.fetchedSongId === id) return
        this.fetchedSongId = id
        this.peaks = []
      }
      let peaks: number[] = []
      try {
        peaks = await getWaveform(id)
      } catch (error) {
        console.error('[song-waveform] Failed to load waveform:', error)
      }
      // The song may have changed again while this was in flight.
      if (this.songId !== id) return

      const MAX_ATTEMPTS = 3
      if (peaks.length === 0 && attempt < MAX_ATTEMPTS - 1) {
        // Most likely a transient failure tied to app boot — a song
        // restored (at its saved, non-zero position) from localStorage
        // fires this fetch alongside a burst of other startup work
        // (library fetch, device discovery, the connect SSE stream, the
        // actual audio stream itself, ...), any of which could delay or
        // trip up this one too. Growing delay, bounded attempts — a song
        // that genuinely has no waveform shouldn't retry forever.
        const delay = 2000 * (attempt + 1)
        setTimeout(() => {
          if (this.songId === id) void this.loadPeaks(id, attempt + 1)
        }, delay)
        return
      }
      this.peaks = peaks
    },
  },
}
</script>
