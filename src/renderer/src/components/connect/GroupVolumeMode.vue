<template>
  <div v-if="shown" class="group-volume-mode">
    <!-- How the player bar's slider moves several speakers at once - see
     - services/groupVolume.ts. Only there while it has something to decide. -->
    <div class="eyebrow-label">{{ $t('connect.groupVolume') }}</div>
    <segmented-control
      :model-value="groupVolumeStore.mode"
      :options="options"
      :label="$t('connect.groupVolume')"
      @update:model-value="onModeChange"
    />
  </div>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'
import { useGroupVolumeStore } from '@/stores/groupVolume'
import SegmentedControl, { type SegmentedOption } from '@/components/SegmentedControl.vue'
import type { GroupVolumeMode } from '@/services/groupVolume'

export default {
  name: 'GroupVolumeMode',
  components: { SegmentedControl },
  computed: {
    groupVolumeStore() {
      return useGroupVolumeStore()
    },
    /** Two speakers with a volume of their own - with fewer, both modes do
     * the same thing. */
    shown(): boolean {
      const connect = useConnectStore()
      return connect.activeTargets.filter((t) => connect.isVolumeCapable(t.type)).length > 1
    },
    options(): SegmentedOption[] {
      return [
        { title: this.$t('connect.groupVolumeEqual'), value: 'equal' },
        { title: this.$t('connect.groupVolumeRelative'), value: 'relative' },
      ]
    },
  },
  methods: {
    onModeChange(mode: string) {
      this.groupVolumeStore.setMode(mode as GroupVolumeMode)
    },
  },
}
</script>

<style scoped>
.group-volume-mode {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0 4px;
}
</style>
