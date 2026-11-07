<template>
  <div>
    <v-btn
      icon="mdi-tune-vertical"
      :color="active ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="$t('equalizer.title')"
      :aria-label="$t('equalizer.title')"
      @click="showDialog = true"
    />
    <equalizer-dialog v-model="showDialog" />
  </div>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import { useEqualizerStore } from '@/stores/equalizer'
import { getAudioEngine } from '@/services/audioEngine'
import { isActive } from '@/services/equalizer'
import EqualizerDialog from './EqualizerDialog.vue'

/** The equalizer for whatever is playing right now - see EqualizerDialog. */
export default {
  name: 'EqualizerButton',
  components: { EqualizerDialog },
  data() {
    return { showDialog: false }
  },
  computed: {
    /** Lit while a curve is changing what is heard: a speaker's while
     * casting, this device's otherwise (where it has a graph to be in). */
    active(): boolean {
      const equalizer = useEqualizerStore()
      const targets = useConnectStore().activeTargets
      if (targets.length > 0) return targets.some((t) => isActive(equalizer.speaker(t)))
      return getAudioEngine().hasAnalyser && isActive(equalizer.local)
    },
  },
}
</script>
