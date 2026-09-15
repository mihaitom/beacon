<template>
  <canvas
    ref="canvasEl"
    class="song-waveform"
    :class="{ 'song-waveform--disabled': disabled, 'song-waveform--dimmed': dimmed }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  />
</template>

<script lang="ts">
import { usePlaybackStore } from '@/stores/playback'
import { getWaveform } from '@/services/connect/waveform'

// Amber tone reused from AudioVisualizer.vue for visual consistency between
// the two player-adjacent visualizations.
const PLAYED_COLOR = 'rgba(245, 169, 78, 0.85)'
const UNPLAYED_COLOR = 'rgba(255, 255, 255, 0.22)'
const MARKER_COLOR = 'rgba(255, 255, 255, 0.9)'
// How far the stream is loaded gets its own thin bar below the waveform
// instead of a third bar colour: the bars already carry position, and a
// third shade of the same two colours on 1px-wide bars was a nuance
// nobody could pick out on a dark screen. As a solid strip with a hard
// edge at the buffer front it needs no fine gradation at all.
const LOAD_BAR_COLOR = 'rgba(245, 169, 78, 0.75)'
const LOAD_TRACK_COLOR = 'rgba(255, 255, 255, 0.1)'
// CSS px, scaled by the device ratio in paint() — a fraction of the
// height (the way the bars are sized) would turn this into a slab on a
// taller instance of the component. The gap is what keeps the strip its
// own row rather than a plinth the bars stand on.
const LOAD_BAR_HEIGHT = 2
const LOAD_BAR_GAP = 1

export default {
  name: 'SongWaveform',
  props: {
    // Mirrors v-slider's own prop/event contract (model-value + @end) so
    // this is a drop-in replacement — see PlayerBar.vue, whose
    // seekPreviewPosition/onSeekEnd logic doesn't need to change at all.
    modelValue: { type: Number, required: true },
    duration: { type: Number, required: true },
    // Blocks dragging — set for radio too, since there is nothing a drag
    // could seek to (see songId below), without implying the bar has
    // nothing worth showing (see `dimmed`, which is what used to be tied
    // to this).
    disabled: { type: Boolean, default: false },
    // How far ahead of modelValue the stream is buffered, in the same
    // seconds — 0 (the default) paints no band at all, which is right for
    // casting and radio, neither of which has a local buffer to show.
    buffered: { type: Number, default: 0 },
    // The faded look for "nothing is playing at all" — kept separate from
    // `disabled` because radio is also non-draggable but very much has
    // something to show (see paint()'s no-peaks branch): how long it's
    // been playing, against the last library track's length.
    dimmed: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'end'],
  data() {
    return {
      peaks: [] as number[],
      resizeObserver: null as ResizeObserver | null,
      dragging: false,
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
    // rather than as a prop — same reasoning as AudioVisualizer.vue reading
    // its own stores for `mode`. Radio has no stable id/seekable position.
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
    modelValue() {
      this.paint()
    },
    duration() {
      this.paint()
    },
    buffered() {
      this.paint()
    },
  },
  mounted() {
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas())
    this.resizeObserver.observe(this.$el)
    this.resizeCanvas()
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect()
  },
  methods: {
    async loadPeaks(id: string | null, attempt = 0) {
      if (!id) {
        this.peaks = []
        this.fetchedSongId = null
        this.paint()
        return
      }
      if (attempt === 0) {
        if (this.fetchedSongId === id) return
        this.fetchedSongId = id
        this.peaks = []
        this.paint()
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
      this.paint()
    },
    resizeCanvas() {
      const canvas = this.$refs.canvasEl as HTMLCanvasElement | undefined
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * ratio))
      canvas.height = Math.max(1, Math.round(rect.height * ratio))
      this.paint()
    },
    // Song-relative seconds for a pointer event's x position, clamped to
    // [0, duration].
    positionFromEvent(e: PointerEvent): number {
      const canvas = this.$refs.canvasEl as HTMLCanvasElement
      const rect = canvas.getBoundingClientRect()
      const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
      return Math.min(this.duration, Math.max(0, ratio * this.duration))
    },
    onPointerDown(e: PointerEvent) {
      if (this.disabled) return
      this.dragging = true
      ;(this.$refs.canvasEl as HTMLCanvasElement).setPointerCapture(e.pointerId)
      this.$emit('update:modelValue', this.positionFromEvent(e))
    },
    onPointerMove(e: PointerEvent) {
      if (!this.dragging) return
      this.$emit('update:modelValue', this.positionFromEvent(e))
    },
    onPointerUp(e: PointerEvent) {
      if (!this.dragging) return
      this.dragging = false
      // Never calls seek() itself — committing once here (not on every
      // drag tick above) is what avoids overlapping seek round-trips while
      // casting, same reasoning as PlayerBar.vue's seekPreviewPosition.
      this.$emit('end', this.positionFromEvent(e))
    },
    /** The loading strip along the bottom edge: filled up to where the
     * stream has got to, empty track beyond it, so the only hard edge in
     * it is the buffer front.
     *
     * It runs from 0 rather than from the playhead, even though
     * `buffered` only ever describes the range covering the current
     * position (audioEngine.ts's reportBuffered()): whatever has played
     * was there to play, and a strip starting mid-bar reads as broken
     * rather than as "measured from here". After a seek forward into
     * nothing the fill ends short of the playhead, which is honest — the
     * playhead marker crosses the strip, so the gap is visible.
     *
     * Nothing is drawn at all when there is no buffer to report (casting,
     * radio), rather than an empty track that would read as "nothing is
     * loaded". */
    paintLoadBar(
      ctx: CanvasRenderingContext2D,
      width: number,
      y: number,
      height: number,
      bufferedX: number,
    ) {
      if (this.buffered <= 0) return
      ctx.fillStyle = LOAD_TRACK_COLOR
      ctx.fillRect(bufferedX, y, width - bufferedX, height)
      ctx.fillStyle = LOAD_BAR_COLOR
      ctx.fillRect(0, y, bufferedX, height)
    },
    paint() {
      const canvas = this.$refs.canvasEl as HTMLCanvasElement | undefined
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const { width, height } = canvas
      ctx.clearRect(0, 0, width, height)
      if (width <= 0 || height <= 0) return

      // Clamped to the canvas width so a position that ever lands past
      // duration (rounding, mostly) reads as fully played instead of
      // drawing a marker off the visible edge.
      const playedRatio = this.duration > 0 ? this.modelValue / this.duration : 0
      const playedX = Math.min(width, playedRatio * width)
      const bufferedRatio = this.duration > 0 ? this.buffered / this.duration : 0
      const bufferedX = Math.min(width, bufferedRatio * width)

      const ratio = window.devicePixelRatio || 1
      const loadBarHeight = Math.max(1, Math.round(LOAD_BAR_HEIGHT * ratio))
      const loadBarY = height - loadBarHeight
      // The bars end above the load bar, clear of it by at least a pixel.
      // That room is reserved whether or not there is anything to load
      // (casting and radio report 0), so the waveform keeps one height
      // instead of growing a pixel the moment a local stream takes over
      // from a cast.
      const baseline = loadBarY - Math.max(1, Math.round(LOAD_BAR_GAP * ratio))
      this.paintLoadBar(ctx, width, loadBarY, loadBarHeight, bufferedX)

      if (this.peaks.length === 0) {
        // A real track whose own waveform just hasn't loaded yet — radio
        // never reaches here at all now (see SeekBar.vue/
        // MobileTransportControls.vue, which swap this component out
        // entirely for a live-elapsed label instead of mounting it with
        // nothing honest to draw).
        ctx.fillStyle = UNPLAYED_COLOR
        ctx.fillRect(0, baseline - 2, width, 2)
        if (playedX > 0) {
          ctx.fillStyle = PLAYED_COLOR
          ctx.fillRect(0, baseline - 2, playedX, 2)
        }
        ctx.fillStyle = MARKER_COLOR
        ctx.fillRect(Math.min(width - 1.5, playedX), 0, 1.5, height)
        return
      }

      const barCount = this.peaks.length
      // width/barCount is always positive regardless of how narrow the
      // container gets — a fixed gap-then-subtract formula (like
      // AudioVisualizer.vue's) can go negative at 300 bars in a cramped
      // layout, since this component's width isn't capped the way that
      // one's BAR_COUNT was sized for.
      const barWidth = width / barCount
      const gap = barWidth > 3 ? 1 : 0
      for (let i = 0; i < barCount; i++) {
        const x = i * barWidth
        // Only the upper half — bars grow up from a bottom baseline
        // instead of mirroring above/below a center line.
        const barHeight = Math.max(1, this.peaks[i]! * baseline * 0.9)
        ctx.fillStyle = x < playedX ? PLAYED_COLOR : UNPLAYED_COLOR
        ctx.fillRect(x, baseline - barHeight, Math.max(0.5, barWidth - gap), barHeight)
      }

      ctx.fillStyle = MARKER_COLOR
      ctx.fillRect(Math.min(width - 1.5, playedX), 0, 1.5, height)
    },
  },
}
</script>

<style scoped>
.song-waveform {
  display: block;
  width: 100%;
  /* A <canvas> with no HTML width/height attribute has a default
   * intrinsic size of 300x150 — as a flex item, min-width: auto (the
   * default) resolves toward that, not toward width: 100% above, so it
   * refused to shrink past ~300px regardless of how narrow .seek-bar
   * actually was. Overflowed the row's own bounds into neighboring
   * elements whenever the available width dropped below that floor,
   * rather than actually filling "however wide .seek-bar is" the way
   * width: 100% already says it should. */
  min-width: 0;
  height: 24px;
  cursor: pointer;
  touch-action: none;
}

.song-waveform--disabled {
  cursor: default;
}

.song-waveform--dimmed {
  opacity: 0.4;
}
</style>
