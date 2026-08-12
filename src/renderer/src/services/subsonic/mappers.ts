import type {
  RawAlbum,
  RawArtist,
  RawPlaylist,
  RawRadioStation,
  RawSong,
} from './types'
import type { Album, Artist, Playlist, RadioStation, Track } from '@/types/library'

export function mapSong(raw: RawSong): Track {
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
    tracks: (raw.song ?? []).map(mapSong),
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
    tracks: (raw.entry ?? []).map(mapSong),
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
