<template>
  <!-- Stays open while columns are picked - see TileContextMenu's
     - closeOnContentClick. Everything else about it (where it appears, the
     - one-open-at-a-time rule, dismiss-on-scroll) is that component's job,
     - the same as for every row and tile menu in the app. -->
  <tile-context-menu ref="menu" :close-on-content-click="false">
    <context-menu-section :label="$t('library.columns')" />
    <!-- A column the connected server has nothing to fill stays on the
       - list, greyed out and saying so: it answers "where is BPM?" at the
       - one place somebody goes looking for it, which hiding it would
       - not. -->
    <v-list-item
      v-for="column in optionalColumns"
      :key="column.key"
      :title="$t(column.labelKey)"
      :subtitle="available(column) ? undefined : $t('library.columnNotReported')"
      :disabled="!available(column)"
      @click="store.toggle(column.key)"
    >
      <template #prepend>
        <v-checkbox-btn
          :model-value="store.columns.includes(column.key)"
          :disabled="!available(column)"
          density="compact"
          class="column-check"
          @click.stop="store.toggle(column.key)"
        />
      </template>
    </v-list-item>
    <v-divider class="column-divider" />
    <v-list-item @click="store.reset()">
      <template #prepend><v-icon icon="mdi-backup-restore" size="small" /></template>
      <v-list-item-title>{{ $t('library.resetColumns') }}</v-list-item-title>
    </v-list-item>
  </tile-context-menu>
</template>

<script lang="ts">
/**
 * The song table's column picker, opened from the column headings
 * themselves (SongTableHeader.vue) rather than from Settings: the columns
 * are right there, and the change is visible the moment it is made.
 *
 * It writes to one app-wide selection (stores/songColumns.ts), so every
 * song table in the app follows it - the picker is about the table as a
 * kind, not about the page it happened to be opened on.
 */
import TileContextMenu from './TileContextMenu.vue'
import ContextMenuSection from './ContextMenuSection.vue'
import { useSongColumnsStore } from '@/stores/songColumns'
import { useAuthStore } from '@/stores/auth'
import {
  OPTIONAL_SONG_COLUMNS,
  songColumnAvailable,
  type SongColumn,
} from '@/services/library/songColumns'

export default {
  name: 'SongColumnMenu',
  components: { TileContextMenu, ContextMenuSection },
  computed: {
    store() {
      return useSongColumnsStore()
    },
    optionalColumns() {
      return OPTIONAL_SONG_COLUMNS
    },
  },
  methods: {
    available(column: SongColumn): boolean {
      return songColumnAvailable(column, useAuthStore().serverType)
    },
    /** Called by the header, from its own right-click or its button. */
    open(event: MouseEvent): void {
      ;(this.$refs.menu as { open: (event: MouseEvent) => void }).open(event)
    },
  },
}
</script>

<style scoped>
/* v-checkbox-btn brings the hit area of a standalone form control, which
 * in a list row pushes the label away from every other menu entry's icon. */
.column-check {
  margin-left: -8px;
}

.column-divider {
  margin: 4px 0;
}
</style>
