import { defineStore } from 'pinia'
import type { SimilarArtistDisplay } from '@/components/library/SimilarArtistsShelf.vue'
import type { Album } from '@/types/library'

export type HomeAlbumList = 'frequent' | 'newest' | 'recent'

/** What Home last showed, kept for the rest of the session so that coming
 * back to Home paints at once instead of from placeholders.
 *
 * The album lists are still asked for on every visit - Home is meant to be
 * current - and this only holds the previous answer on screen until the new
 * one lands. Discover is different: its lookup is the slow one (MusicBrainz,
 * ListenBrainz, then a photo and links per artist) and its seeds are pinned
 * anyway (see HomeView's pickSeedArtistNames), so redoing it on every visit
 * produced nearly the same shelves seconds later. It is kept until somebody
 * shuffles it or `discoverSource` no longer matches.
 *
 * Memory only. Top songs and Rediscover come from the song catalogue, which
 * has its own cache; a cold start asks the server like before. */
export const useHomeStore = defineStore('home', {
  state: () => ({
    // Null until the first answer, which is what tells a first visit
    // (placeholders) apart from a return (the old list, refreshed quietly).
    albums: { frequent: null, newest: null, recent: null } as Record<HomeAlbumList, Album[] | null>,
    discoverAlbums: [] as Album[],
    discoverArtists: [] as SimilarArtistDisplay[],
    discoverPersonal: false,
    // Which kind of lookup filled the Discover shelves (see HomeView's
    // discoverSource), or null while they hold nothing worth keeping.
    discoverSource: null as string | null,
  }),
  actions: {
    /** Album and artist ids are only unique within one media server. */
    reset(): void {
      this.$reset()
    },
  },
})
