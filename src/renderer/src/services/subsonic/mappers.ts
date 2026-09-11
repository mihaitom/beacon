import type { RawAlbum, RawArtist, RawPlaylist, RawRadioStation, RawSong } from './types'
import type { Album, Artist, Playlist, RadioStation, Song } from '@/types/library'

export function mapSong(raw: RawSong): Song {
  return {
    id: raw.id,
    title: raw.title,
    artist: raw.artist ?? 'Unknown',
    artistId: raw.artistId ?? '',
    album: raw.album ?? '',
    albumId: raw.albumId ?? '',
    duration: raw.duration ?? 0,
    trackNumber: raw.track ?? null,
    discNumber: raw.discNumber ?? null,
    year: raw.year ?? null,
    genre: raw.genre ?? null,
    coverArtId: raw.coverArt ?? null,
    starred: raw.starred != null,
    rating: raw.userRating ?? 0,
    playCount: raw.playCount ?? 0,
    format: raw.suffix ?? null,
    bitRate: raw.bitRate ?? null,
    replayGain: raw.replayGain
      ? {
          trackGain: raw.replayGain.trackGain,
          albumGain: raw.replayGain.albumGain,
          trackPeak: raw.replayGain.trackPeak,
          albumPeak: raw.replayGain.albumPeak,
        }
      : null,
    // The optional columns. A server that sends none of these (plain
    // Subsonic, or a bridge whose list response doesn't carry the field)
    // leaves them null, which is what the column renders as blank - see
    // services/library/songColumns.ts.
    added: raw.created ?? null,
    lastPlayed: raw.played ?? null,
    size: raw.size ?? null,
    // Navidrome writes a 0 into bpm and samplingRate/bitDepth for a file
    // that has no such tag at all, so a plain ?? would turn "unknown" into
    // a printed zero.
    bpm: raw.bpm || null,
    sampleRate: raw.samplingRate || null,
    bitDepth: raw.bitDepth || null,
    comment: raw.comment || null,
    path: raw.path ?? null,
  }
}

export function mapAlbum(raw: RawAlbum): Album {
  return {
    id: raw.id,
    name: raw.name,
    artist: raw.artist ?? 'Unknown',
    artistId: raw.artistId ?? '',
    coverArtId: raw.coverArt ?? null,
    songCount: raw.songCount,
    duration: raw.duration,
    year: raw.year ?? null,
    genre: raw.genre ?? null,
    starred: raw.starred != null,
    rating: raw.userRating ?? 0,
    songs: (raw.song ?? []).map(mapSong),
  }
}

export function mapArtist(raw: RawArtist): Artist {
  return {
    id: raw.id,
    name: raw.name,
    albumCount: raw.albumCount ?? raw.album?.length ?? 0,
    coverArtId: raw.coverArt ?? null,
    imageUrl: raw.artistImageUrl ?? null,
    starred: raw.starred != null,
    rating: raw.userRating ?? 0,
    albums: (raw.album ?? []).map(mapAlbum),
  }
}

export function mapPlaylist(raw: RawPlaylist): Playlist {
  return {
    id: raw.id,
    name: raw.name,
    songCount: raw.songCount,
    duration: raw.duration,
    coverArtId: raw.coverArt ?? null,
    public: raw.public ?? false,
    owner: raw.owner ?? '',
    songs: (raw.entry ?? []).map(mapSong),
  }
}

export function mapRadioStation(raw: RawRadioStation): RadioStation {
  return {
    id: raw.id,
    name: raw.name,
    streamUrl: raw.streamUrl,
    homePageUrl: raw.homePageUrl ?? null,
  }
}
