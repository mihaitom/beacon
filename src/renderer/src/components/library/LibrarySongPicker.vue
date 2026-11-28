<template>
  <!-- A song picked out of the library rather than typed as free text, so
   - whatever it is sent to is always asked about a song this server
   - actually holds. -->
  <v-autocomplete
    :model-value="modelValue"
    :search="query"
    :items="options"
    :item-title="songLabel"
    :loading="searching"
    :label="label"
    :placeholder="$t('lastfm.seedTrackPlaceholder')"
    variant="solo-filled"
    hide-details
    no-filter
    return-object
    clearable
    @update:model-value="$emit('update:modelValue', $event ?? null)"
    @update:search="onSearch"
  >
    <!-- Vuetify's own "No data available" reads as a fault; before
     - anything is typed this is simply an empty search box. -->
    <template #no-data>
      <v-list-item>
        <v-list-item-title class="text-medium-emphasis">
          {{
            searching
              ? $t('common.loading')
              : query.trim().length < 2
                ? $t('lastfm.seedHint')
                : $t('lastfm.seedNoResults')
          }}
        </v-list-item-title>
      </v-list-item>
    </template>
    <!-- Title, then artist, then the cover: the same three things a song
     - row shows, so a hit is recognisable without reading the artist off a
     - single combined line. -->
    <template #item="{ props: optionProps, item }">
      <v-list-item v-bind="optionProps" :title="item.title" :subtitle="item.artist">
        <template #prepend>
          <cover-art :cover-art-id="item.coverArtId" :size="36" class="option__art" />
        </template>
      </v-list-item>
    </template>
  </v-autocomplete>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useLibraryStore } from '@/stores/library'
import type { Song } from '@/types/library'
import CoverArt from './CoverArt.vue'

const SEARCH_DEBOUNCE_MS = 300
const RESULT_COUNT = 15

/** "Artist · Title", the pair a track is identified by everywhere else in
 * the app. */
export function songLabel(song: Song): string {
  return `${song.artist} · ${song.title}`
}

/** A library search box that hands back one picked song. */
export default {
  name: 'LibrarySongPicker',
  components: { CoverArt },
  props: {
    modelValue: { type: Object as PropType<Song | null>, default: null },
    label: { type: String, required: true },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      query: '',
      options: [] as Song[],
      searching: false,
      seq: 0,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  beforeUnmount() {
    clearTimeout(this.timer)
  },
  methods: {
    songLabel,

    /** Keeps the search text and the picked song in step: typing over a
     * picked song clears it (otherwise it would stay on the old song while
     * the field shows a new query), and a fresh query is looked up after a
     * pause rather than on every keystroke. */
    onSearch(value: string | null): void {
      const text = value ?? ''
      const label = this.modelValue ? songLabel(this.modelValue) : ''
      this.query = text
      if (text === label) return
      if (this.modelValue) this.$emit('update:modelValue', null)
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.search(), SEARCH_DEBOUNCE_MS)
    },

    /** A response a newer query already superseded is dropped rather than
     * shown under the new text. */
    async search(): Promise<void> {
      const query = this.query.trim()
      if (query.length < 2) {
        this.options = []
        return
      }
      const seq = ++this.seq
      this.searching = true
      try {
        const songs = (await useLibraryStore().client().search3(query, RESULT_COUNT, 0, 0)).songs
        if (seq === this.seq) this.options = songs
      } catch (error) {
        console.error('[builder] Library song search failed:', error)
        if (seq === this.seq) this.options = []
      } finally {
        if (seq === this.seq) this.searching = false
      }
    },
  },
}
</script>

<style scoped>
/* Vuetify's prepend slot leaves too little gap here, so the title sits
 * against the cover. */
.option__art {
  border-radius: 4px;
  margin-right: 12px;
}
</style>
