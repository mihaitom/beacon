<template>
  <div
    class="radio-row mobile-row"
    :class="{ 'radio-row--current': isCurrent }"
    @click="$emit('play', station)"
    @contextmenu.prevent="openMenu($event)"
  >
    <!-- Rounded, and smaller than the tile's 72px: this row is modelled on
     - the phone remote's own radio list (connect/static/remote/js/views/
     - radio.js and app.css's .row/.row-art), which reads better on a phone
     - than a grid of bordered boxes — one line per station, tap anywhere
     - to play. -->
    <cover-art
      :radio-favicon="station.homePageUrl ? faviconRequest(station.homePageUrl, 48) : null"
      :size="MOBILE_ROW_ART_SIZE"
      rounded
      fallback-icon="mdi-radio"
      class="mobile-row__art"
    />
    <div class="mobile-row__text">
      <div class="text-body-medium" :class="{ 'text-primary': isCurrent }">
        {{ station.name }}
      </div>
      <!-- The site the station belongs to, not the stream URL — see
       - RadioStationCard.vue's own hostname comment. A station with none
       - simply drops the line. -->
      <div v-if="hostname" class="text-body-small text-medium-emphasis radio-row__host">
        {{ hostname }}
      </div>
    </div>
    <!-- What the remote's own list has no equivalent for, and the reason
     - this is not just a copy of it: editing and deleting a station has to
     - stay reachable by a plain tap, there being no hover here. -->
    <v-btn
      icon="mdi-dots-vertical"
      variant="text"
      density="comfortable"
      size="small"
      class="radio-row__menu"
      :title="$t('common.edit')"
      @click.stop="openMenu($event)"
    />
    <tile-context-menu ref="menu">
      <v-list-item @click="$emit('edit', station)">
        <template #prepend><v-icon icon="mdi-pencil-outline" size="small" /></template>
        <v-list-item-title>{{ $t('common.edit') }}</v-list-item-title>
      </v-list-item>
      <v-list-item @click="$emit('delete', station)">
        <template #prepend><v-icon icon="mdi-delete-outline" size="small" /></template>
        <v-list-item-title>{{ $t('common.delete') }}</v-list-item-title>
      </v-list-item>
    </tile-context-menu>
  </div>
</template>

<script lang="ts">
// The phone's radio list row, beside the other Mobile* rows it shares its
// .mobile-row primitives (and its measurements against the LAN remote, see
// __tests__/mobileRemoteParity.test.ts) with. It sat in components/library
// next to RadioStationCard for a while, which is the desktop tile — same
// subject, opposite layout, and the only one of the phone's rows filed
// away from its siblings.
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import { MOBILE_ROW_ART_SIZE } from './rowMetrics'
import TileContextMenu from '@/components/library/TileContextMenu.vue'
import { usePlaybackStore } from '@/stores/playback'
import { radioFaviconRequest, type RadioFaviconRequest } from '@/services/connect/radio'
import type { RadioStation } from '@/types/library'

export default {
  name: 'MobileRadioRow',
  components: { CoverArt, TileContextMenu },
  props: {
    station: {
      type: Object as PropType<RadioStation>,
      required: true,
    },
  },
  emits: ['play', 'edit', 'delete'],
  data() {
    return { MOBILE_ROW_ART_SIZE }
  },
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    // Same three derivations RadioStationCard.vue makes, and for the same
    // reasons — see its own comments on matching by id and on preferring
    // the homepage's host over the stream's.
    isCurrent(): boolean {
      return this.playbackStore.radioStation?.id === this.station.id
    },
    hostname(): string {
      return this.hostnameOf(this.station.homePageUrl || this.station.streamUrl)
    },
  },
  methods: {
    faviconRequest(homePageUrl: string, minSize = 0): RadioFaviconRequest {
      return radioFaviconRequest(homePageUrl ?? '', minSize, this.station.favicon ?? '')
    },
    hostnameOf(url: string): string {
      try {
        return new URL(url).hostname.replace(/^www\./, '')
      } catch {
        return ''
      }
    },
    openMenu(event: MouseEvent) {
      const menu = this.$refs.menu as { open: (event: MouseEvent) => void } | undefined
      menu?.open(event)
    },
  },
}
</script>

<style scoped>
/* The separator comes from .mobile-row now, the same as every other list
 * on the phone — this row briefly had one of its own, which made it the
 * only ruled list among four unruled ones. */
.radio-row {
  cursor: pointer;
}

/* :active as well as :hover — a phone has no hover to give feedback with,
 * and this row exists for the phone. */
.radio-row:hover,
.radio-row:active {
  background: var(--beacon-hover);
}

/* The station playing right now, marked the way the remote marks it: the
 * name in the accent colour rather than a filled, tinted box. */
.radio-row--current {
  background: rgba(var(--v-theme-primary), 0.06);
}

.radio-row__menu {
  flex-shrink: 0;
}
</style>
