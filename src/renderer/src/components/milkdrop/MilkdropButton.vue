<template>
  <div>
    <v-btn
      icon="mdi-tune-variant"
      :color="showDialog ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="$t('milkdrop.title')"
      :aria-label="$t('milkdrop.title')"
      @click="open"
    />
    <milkdrop-dialog v-model="showDialog" :current="current" :right-inset="rightInset" />
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
    return { showDialog: false, rightInset: 0 }
  },
  methods: {
    open(): void {
      const nowPlaying = (this.$el as HTMLElement).closest('.now-playing')
      const right = nowPlaying?.getBoundingClientRect().right
      this.rightInset = right ? Math.max(0, window.innerWidth - right) : 0
      this.showDialog = true
    },
  },
}
</script>
