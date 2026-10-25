<template>
  <!-- Inline on purpose: the caller's class makes the box (block, ellipsis),
   - the names inside it flow and truncate as one line. -->
  <span class="artist-credit">
    <template v-for="(part, index) in parts" :key="index">
      <span v-if="index > 0" class="artist-credit__separator" aria-hidden="true"> · </span>
      <router-link
        v-if="linked && part.id"
        :to="`${mobile ? '/m' : ''}/artists/${part.id}`"
        draggable="false"
        class="artist-credit__link"
        @click.stop
      >
        {{ part.name }}
      </router-link>
      <template v-else>{{ part.name }}</template>
    </template>
  </span>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useLibraryStore } from '@/stores/library'
import type { CreditPart } from '@/services/artistCredits'

/** A song's artist line, one link per performer and a middle dot between
 * them - see splitCredit() for how "feat." and "&" are told from a name. */
export default {
  name: 'ArtistCredit',
  props: {
    credit: { type: String, required: true },
    /** The server's artistId, the link while the credit stays one piece. */
    artistId: { type: String as PropType<string | null>, default: null },
    linked: { type: Boolean, default: true },
    /** Link into the phone shell's artist pages. */
    mobile: { type: Boolean, default: false },
  },
  computed: {
    parts(): CreditPart[] {
      return useLibraryStore().artistCredit(this.credit, this.artistId)
    },
  },
}
</script>

<style scoped>
.artist-credit__link {
  color: inherit;
  text-decoration: none;
}

.artist-credit__link:hover {
  color: rgb(var(--v-theme-primary));
}
</style>
