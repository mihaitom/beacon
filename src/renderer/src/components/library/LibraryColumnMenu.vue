<template>
  <!-- SongColumnMenu.vue's picker for the album and artist lists: stays
     - open while columns are picked. -->
  <tile-context-menu ref="menu" :close-on-content-click="false">
    <context-menu-section :label="$t('library.columns')" />
    <v-list-item
      v-for="choice in choices"
      :key="choice.key"
      :title="choice.label"
      @click="$emit('toggle', choice.key)"
    >
      <template #prepend>
        <v-checkbox-btn
          :model-value="choice.checked"
          density="compact"
          class="column-check"
          @click.stop="$emit('toggle', choice.key)"
        />
      </template>
    </v-list-item>
    <v-divider class="column-divider" />
    <v-list-item @click="$emit('reset')">
      <template #prepend><v-icon icon="mdi-backup-restore" size="small" /></template>
      <v-list-item-title>{{ $t('library.resetColumns') }}</v-list-item-title>
    </v-list-item>
  </tile-context-menu>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'

export interface ColumnChoice {
  key: string
  label: string
  checked: boolean
}

export default {
  name: 'LibraryColumnMenu',
  components: { TileContextMenu, ContextMenuSection },
  props: {
    choices: { type: Array as PropType<ColumnChoice[]>, required: true },
  },
  emits: ['toggle', 'reset'],
  methods: {
    open(event: MouseEvent): void {
      ;(this.$refs.menu as { open: (event: MouseEvent) => void }).open(event)
    },
  },
}
</script>

<style scoped>
/* See SongColumnMenu.vue's identical rules. */
.column-check {
  margin-left: -8px;
}

.column-divider {
  margin: 4px 0;
}
</style>
