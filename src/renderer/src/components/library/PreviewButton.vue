<template>
  <!-- A pill beside Play on a page that has room for words, the bare icon
   - in a phone header that has room for one more button. -->
  <v-btn
    v-if="compact"
    icon="mdi-headphones"
    variant="text"
    size="large"
    :disabled="!available"
    :loading="loading"
    :title="$t('library.preview')"
    :aria-label="$t('library.preview')"
    @click.prevent.stop="start"
  />
  <v-btn
    v-else
    variant="tonal"
    :rounded="pill ? 'pill' : undefined"
    :size="size"
    prepend-icon="mdi-headphones"
    :disabled="!available"
    :loading="loading"
    @click.prevent.stop="start"
  >
    {{ $t('library.preview') }}
  </v-btn>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { usePartyStore } from '@/stores/party'
import type { Song } from '@/types/library'

/** Previews an album or playlist - see the playback store's
 * startPreview(). Given its `songs`, or, where they are not loaded yet (a
 * row in a list of playlists), `load` to fetch them on the click and
 * `songCount` to know beforehand whether there is anything. Its click stays
 * its own, so a button inside a link does not follow it. */
export default {
  name: 'PreviewButton',
  props: {
    songs: { type: Array as PropType<Song[] | null>, default: null },
    load: { type: Function as PropType<(() => Promise<Song[]>) | null>, default: null },
    songCount: { type: Number, default: 0 },
    compact: { type: Boolean, default: false },
    size: { type: String, default: undefined },
    pill: { type: Boolean, default: true },
  },
  data() {
    return { loading: false }
  },
  computed: {
    /** Not while guests listening along to a party would hear it: they
     * read the mix of the window hosting it, or the cast's. */
    available(): boolean {
      const party = usePartyStore()
      const heardByGuests = party.enabled && (party.hostedHere || usePlaybackStore().isCasting)
      const count = this.songs ? this.songs.length : this.songCount
      return count > 0 && !heardByGuests
    },
  },
  methods: {
    async start() {
      if (this.loading) return
      let songs = this.songs
      if (!songs && this.load) {
        this.loading = true
        try {
          songs = await this.load()
        } catch (error) {
          console.error('[preview] Failed to load the songs:', error)
          return
        } finally {
          this.loading = false
        }
      }
      if (songs?.length) void usePlaybackStore().startPreview(songs)
    },
  },
}
</script>
