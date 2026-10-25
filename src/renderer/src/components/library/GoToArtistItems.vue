<template>
  <!-- One entry per performer once a credit names several, each with its
   - name, the way DetailHeader labels its artist button. -->
  <v-list-item v-for="part in targets" :key="part.id!" :to="`/artists/${part.id}`">
    <template #prepend><v-icon icon="mdi-account-music" size="small" /></template>
    <v-list-item-title>
      {{
        targets.length > 1 ? `${$t('library.goToArtist')}: ${part.name}` : $t('library.goToArtist')
      }}
    </v-list-item-title>
  </v-list-item>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useLibraryStore } from '@/stores/library'
import type { CreditPart } from '@/services/artistCredits'

/** A context menu's "Go to artist", for every artist ArtistCredit links. */
export default {
  name: 'GoToArtistItems',
  props: {
    credit: { type: String, required: true },
    artistId: { type: String as PropType<string | null>, default: null },
  },
  computed: {
    targets(): CreditPart[] {
      return useLibraryStore()
        .artistCredit(this.credit, this.artistId)
        .filter((part) => part.id)
    },
  },
}
</script>
