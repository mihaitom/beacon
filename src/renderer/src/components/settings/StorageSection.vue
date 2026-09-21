<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.storageTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.clearCacheHint') }}</p>
        <v-btn
          variant="tonal"
          prepend-icon="mdi-broom"
          :loading="clearingCache"
          :disabled="clearingCache"
          @click="clearCache"
        >
          {{ $t('settings.clearCache') }}
        </v-btn>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { clearLyricsCache } from '@/stores/lyrics'
import { clearCoverArtCache } from '@/services/connect/coverArtBatch'
import { clearRadioFaviconCache } from '@/services/connect/radioFaviconBatch'

/**
 * Throwing away what Beacon keeps locally: the library, lyrics, artwork
 * and station-logo caches, all on this device alone. It sits in the
 * admin-only Advanced tab as housekeeping, but it never reaches the
 * backend — the Connect cache and every other device are untouched, so
 * nothing but this browser is affected (a second account sharing it loses
 * its local copy too, which only costs a refetch). Recoverable by doing the
 * thing again, which is why it asks for no confirmation.
 */
export default {
  name: 'StorageSection',
  data() {
    return {
      clearingCache: false,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
  },
  methods: {
    async clearCache() {
      this.clearingCache = true
      try {
        await Promise.all([
          this.libraryStore.invalidateCache(),
          clearLyricsCache(),
          clearCoverArtCache(),
        ])
        clearRadioFaviconCache()
      } finally {
        this.clearingCache = false
      }
      this.$emitter.emit('toast', {
        level: 'success',
        title: this.$t('settings.clearCache'),
        message: this.$t('settings.cacheCleared'),
      })
    },
  },
}
</script>
