<template>
  <div>
    <v-btn
      icon="mdi-tune-variant"
      :color="open ? 'primary' : undefined"
      variant="text"
      density="comfortable"
      :title="$t('milkdrop.title')"
      :aria-label="$t('milkdrop.title')"
      @click="show"
    />
    <!-- As the app's menu (MilkdropButton): at Now Playing's right edge,
     - not the window's where the queue panel is, and no scrim - the picture
     - it changes stays in view. -->
    <v-dialog
      v-model="open"
      width="420"
      scrollable
      :scrim="false"
      transition="slide-x-reverse-transition"
      class="guest-milkdrop-overlay"
      :style="{ '--guest-milkdrop-right': `${rightInset}px` }"
    >
      <v-card class="beacon-dialog">
        <v-card-title>{{ $t('milkdrop.title') }}</v-card-title>
        <v-card-text>
          <milkdrop-preset-picker
            ref="picker"
            :entries="entries"
            :current="current"
            @choose="source.chooseMilkdropPreset($event)"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="open = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import MilkdropPresetPicker from '@/components/milkdrop/MilkdropPresetPicker.vue'
import { nowPlayingSourceMixin } from '@/components/now-playing/useSource'
import { BUILTIN_PRESETS } from '@/services/milkdrop/presets'

/** The guest's Milkdrop menu: Beacon's shipped presets to pick from, and
 * the places the roaming ones can be sent to. No pool, no uploads - those
 * belong to the host's account. */
export default {
  name: 'GuestMilkdropButton',
  components: { MilkdropPresetPicker },
  mixins: [nowPlayingSourceMixin],
  props: {
    /** The preset on screen right now. */
    current: {
      type: String as PropType<string | null>,
      default: null,
    },
  },
  data() {
    return { open: false, rightInset: 0, entries: BUILTIN_PRESETS }
  },
  methods: {
    show(): void {
      const nowPlaying = (this.$el as HTMLElement).closest('.now-playing')
      const right = nowPlaying?.getBoundingClientRect().right
      this.rightInset = right ? Math.max(0, window.innerWidth - right) : 0
      this.open = true
    },
  },
  watch: {
    open(isOpen: boolean) {
      if (!isOpen) return
      void this.$nextTick(() =>
        (this.$refs.picker as { revealCurrent(): void } | undefined)?.revealCurrent(),
      )
    },
  },
}
</script>

<!-- Unscoped: v-dialog teleports its overlay out of this component. -->
<style>
.guest-milkdrop-overlay.v-dialog {
  justify-content: flex-end;
}

.guest-milkdrop-overlay.v-dialog > .v-overlay__content {
  margin: 16px;
  margin-right: calc(16px + var(--guest-milkdrop-right, 0px));
}
</style>
