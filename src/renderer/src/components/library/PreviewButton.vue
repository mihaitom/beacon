<template>
  <!-- A pill beside Play on a page that has room for words, the bare icon
   - in a phone header that has room for one more button. -->
  <v-btn
    v-if="compact"
    icon="mdi-headphones"
    variant="text"
    size="large"
    :disabled="!available"
    :title="$t('library.preview')"
    :aria-label="$t('library.preview')"
    @click="start"
  />
  <v-btn
    v-else
    variant="tonal"
    rounded="pill"
    :size="size"
    prepend-icon="mdi-headphones"
    :disabled="!available"
    @click="start"
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
 * startPreview(). */
export default {
  name: 'PreviewButton',
  props: {
    songs: { type: Array as PropType<Song[]>, required: true },
    compact: { type: Boolean, default: false },
    size: { type: String, default: undefined },
  },
  computed: {
    /** Not while guests listening along to a party would hear it: they
     * read the mix of the window hosting it, or the cast's. */
    available(): boolean {
      const party = usePartyStore()
      const heardByGuests = party.enabled && (party.hostedHere || usePlaybackStore().isCasting)
      return this.songs.length > 0 && !heardByGuests
    },
  },
  methods: {
    start() {
      void usePlaybackStore().startPreview(this.songs)
    },
  },
}
</script>
