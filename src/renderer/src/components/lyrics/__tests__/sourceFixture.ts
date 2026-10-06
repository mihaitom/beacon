import { computed, markRaw, reactive } from 'vue'
import { useLyricsStore } from '@/stores/lyrics'
import { usePlaybackStore } from '@/stores/playback'
import LyricsCandidateList from '@/components/lyrics/LyricsCandidateList.vue'
import {
  lyricsSourceLabel,
  lyricsSourceUrl,
  lyricsStatus,
} from '@/components/now-playing/hostSource'
import { nowPlayingSourceKey, type NowPlayingSource } from '@/components/now-playing/source'

/** A minimal host source for tests that mount a presentation component on
 * its own (the LyricsPanel tests): the parts it reads, backed by the same
 * stores the tests configure, so those tests keep working through the
 * stores exactly as before. */
export function lyricsSourceFixture(): NowPlayingSource {
  const lyrics = useLyricsStore()
  const playback = usePlaybackStore()
  return reactive({
    lyrics: reactive({
      lines: computed(() => lyrics.lines),
      synced: computed(() => lyrics.synced),
      offset: computed(() => lyrics.offset),
      songKey: computed(() => lyrics.songId),
      loading: computed(() => lyrics.loading),
      status: computed(() => lyricsStatus(playback.currentSong?.id ?? null)),
      sourceLabel: computed(() => lyricsSourceLabel()),
      sourceUrl: computed(() => lyricsSourceUrl()),
      credits: computed(() => lyrics.credits),
    }),
    position: computed(() => playback.localPosition),
    // The host-only leaves a real host source would carry (see
    // hostSource.ts); the picker tests reach for this one.
    cover: markRaw({ template: '<div />' }),
    titleLogComponent: null,
    lyricsCandidateComponent: markRaw(LyricsCandidateList),
    capabilities: reactive({ lyricsTools: true }),
    setLyricsOffset: (offset: number) => lyrics.setOffset(offset),
    resetLyricsOffset: (offset: number) => lyrics.setOffset(0 - offset),
    seek: (seconds: number) => void playback.seek(seconds),
    loadLyricsCandidates: () => {
      if (playback.currentSong) void lyrics.loadCandidates(playback.currentSong)
    },
    clearLyricsCandidates: () => lyrics.clearCandidates(),
  }) as unknown as NowPlayingSource
}

/** The `provide` option for a mount that renders a LyricsPanel. */
export function provideLyricsSource(): Record<symbol, NowPlayingSource> {
  return { [nowPlayingSourceKey]: lyricsSourceFixture() }
}
