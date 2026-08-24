import type { Song } from '@/types/library'
import type { ConnectStatus } from '@/services/connect/types'

export function makeSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Test Artist',
    artistId: 'artist-1',
    album: 'Test Album',
    albumId: 'album-1',
    duration: 180,
    trackNumber: 1,
    discNumber: 1,
    year: 2024,
    genre: null,
    coverArtId: null,
    starred: false,
    rating: 0,
    playCount: 0,
    format: 'flac',
    bitRate: 900,
    replayGain: null,
    ...overrides,
  }
}

/** Full ConnectStatus defaults so each test only has to spell out the
 * fields it actually cares about. */
export function makeStatus(overrides: Partial<ConnectStatus> = {}): ConnectStatus {
  return {
    current_song: null,
    stream_info: {
      label: 'mp3-192k (fallback)',
      content_type: 'audio/mpeg',
      transcoding: true,
      source_codec: null,
      source_sample_rate: null,
      source_bit_depth: null,
      source_bitrate_kbps: null,
      active_connections: 0,
      loop_lag: 0,
    },
    queue: [],
    current_song_index: -1,
    original_queue: [],
    shuffle: false,
    repeat_mode: 'off',
    elapsed: 0,
    ended: false,
    paused: false,
    radio: null,
    streaming: false,
    targets: [],
    total_songs: 0,
    displaced: false,
    interrupted: false,
    ...overrides,
  }
}
