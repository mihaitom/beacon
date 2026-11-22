<template>
  <div>
    <v-btn
      icon="mdi-tune-variant"
      variant="text"
      density="comfortable"
      :title="$t('milkdrop.title')"
      :aria-label="$t('milkdrop.title')"
      @click="showDialog = true"
    />
    <milkdrop-dialog v-model="showDialog" :current="current" />
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import MilkdropDialog from './MilkdropDialog.vue'

export default {
  name: 'MilkdropButton',
  components: { MilkdropDialog },
  props: {
    /** The preset on screen right now. */
    current: {
      type: String as PropType<string | null>,
      default: null,
    },
  },
  data() {
    return { showDialog: false }
  },
}
</script>
