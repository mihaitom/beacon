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

      <div class="setting">
        <p class="setting__description">{{ $t('settings.resetAirplayHint') }}</p>
        <v-btn
          variant="tonal"
          prepend-icon="mdi-cast-off"
          :loading="resettingAirplay"
          @click="resetAirplayPairings"
        >
          {{ $t('settings.resetAirplay') }}
        </v-btn>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { useConnectStore } from '@/stores/connect'
import { clearLyricsCache } from '@/stores/lyrics'
import { clearCoverArtCache } from '@/services/connect/coverArtBatch'
import { clearRadioFaviconCache } from '@/services/connect/radioFaviconBatch'

/**
 * Throwing away what Beacon keeps locally: the library/artwork caches,
 * and the AirPlay pairings held by the backend. Both are recoverable by
 * doing the thing again, which is why neither asks for confirmation.
 */
export default {
  name: 'StorageSection',
  data() {
    return {
      clearingCache: false,
      resettingAirplay: false,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    connectStore() {
      return useConnectStore()
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
    async resetAirplayPairings() {
      this.resettingAirplay = true
      try {
        await this.connectStore.unpairAll()
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.resetAirplay'),
          message: this.$t('settings.airplayReset'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.resetAirplay'),
          message: this.$t('settings.airplayResetFailed'),
        })
        console.error('[settings] Failed to reset AirPlay pairings:', error)
      } finally {
        this.resettingAirplay = false
      }
    },
  },
}
</script>
