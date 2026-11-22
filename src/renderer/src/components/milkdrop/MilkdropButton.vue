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
    <milkdrop-dialog v-model="showDialog" />
  </div>
</template>

<script lang="ts">
import MilkdropDialog from './MilkdropDialog.vue'

export default {
  name: 'MilkdropButton',
  components: { MilkdropDialog },
  data() {
    return { showDialog: false }
  },
}
</script>
