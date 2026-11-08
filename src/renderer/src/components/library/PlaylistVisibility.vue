<template>
  <!-- Two tiles rather than a switch: "public" alone does not say who gets
   - to see it, and the answer is the whole reason to stop and choose. -->
  <choice-tiles
    :model-value="modelValue ? 'public' : 'private'"
    :options="options"
    :label="$t('playlists.public')"
    @update:model-value="$emit('update:modelValue', $event === 'public')"
  />
</template>

<script lang="ts">
import ChoiceTiles, { type ChoiceTile } from '@/components/ChoiceTiles.vue'

export default {
  name: 'PlaylistVisibility',
  components: { ChoiceTiles },
  props: {
    /** True for public. */
    modelValue: { type: Boolean, required: true },
  },
  emits: ['update:modelValue'],
  computed: {
    options(): ChoiceTile[] {
      return [
        {
          value: 'private',
          icon: 'mdi-lock-outline',
          name: this.$t('playlists.private'),
          hint: this.$t('playlists.privateHint'),
        },
        {
          value: 'public',
          icon: 'mdi-earth',
          name: this.$t('playlists.public'),
          hint: this.$t('playlists.publicHint'),
        },
      ]
    },
  },
}
</script>
