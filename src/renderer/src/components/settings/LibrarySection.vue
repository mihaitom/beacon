<template>
  <!-- The section itself is unconditional, only what's inside it isn't:
   - the recommendations toggle at the bottom applies to every server and
   - every account, while the scan/refresh above it does not (a
   - non-admin Navidrome account has neither — see
   - services/capabilities.ts's libraryScan). Gating the whole <section>
   - on those, as it used to be, would take the toggle away with them. -->
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.libraryTitle') }}</h2>
    <div class="beacon-panel">
      <div v-if="authStore.capabilities.libraryScan" class="setting">
        <p class="setting__description">
          {{ $t('settings.libraryScanHint', { server: serverName }) }}
        </p>
        <!-- The label stays put while the scan runs; the progress is the
           - ring in the button and the figure beside it. Vuetify hides a
           - loading button's own content (`.v-btn__content { opacity: 0 }`)
           - but keeps it in the layout, so a label swapped for a progress
           - one was invisible *and* still sized the button: it shrank on
           - the first click, grew again with every digit the count gained,
           - and snapped back to full width at the end. -->
        <div class="setting__control-row">
          <v-btn
            color="primary"
            prepend-icon="mdi-refresh"
            :loading="scanning"
            :disabled="scanning"
            @click="rescanLibrary"
          >
            <!-- The spinner Vuetify would draw, made to say how far
               - along the scan is wherever the server knows: Jellyfin and
               - Plex report a percentage, Navidrome counts items with no
               - total to divide by and so keeps the ring turning
               - instead. -->
            <template #loader>
              <v-progress-circular
                :indeterminate="scanPercent === null"
                :model-value="scanPercent ?? undefined"
                size="24"
                width="2"
              />
            </template>
            {{ $t('settings.rescanLibrary') }}
          </v-btn>
          <!-- Beside the button rather than under it: it is the state of
             - that button, not a note about the section, and a ring that
             - only turns (Navidrome, which counts items with no total)
             - needs the number to say anything at all. -->
          <span v-if="scanning" class="setting__status">{{ scanLabel }}</span>
        </div>
      </div>

      <!-- Jellyfin has no server-side scan-trigger of its own (see
       - capabilities.libraryScan) — this instead forces Beacon's own cached
       - view of the library to refetch now, rather than waiting for
       - CACHE_TTL_MS. Shows real progress since a large Jellyfin library can
       - take a couple of minutes (see stores/library.ts's refreshLibrary()). -->
      <div v-else-if="authStore.serverType === 'jellyfin'" class="setting">
        <p class="setting__description">{{ $t('settings.libraryRefreshHint') }}</p>
        <!-- Same fixed label, same reason as the scan button above. This
           - one already had somewhere to put its progress; it now carries
           - the count as well, which used to be written invisibly into the
           - button. -->
        <v-btn
          color="primary"
          prepend-icon="mdi-refresh"
          :loading="refreshingLibrary"
          :disabled="refreshingLibrary"
          @click="refreshLibrary"
        >
          {{ $t('settings.refreshLibrary') }}
        </v-btn>
        <v-progress-linear
          v-if="refreshingLibrary"
          class="settings-progress"
          :indeterminate="refreshProgressPercent === null"
          :model-value="refreshProgressPercent ?? undefined"
          color="primary"
          height="6"
          rounded
        />
        <p v-if="refreshingLibrary && refreshProgressLabel" class="setting__hint">
          {{ refreshProgressLabel }}
        </p>
      </div>

      <!-- Discover's seed artists come out of the library itself, which is
       - what puts this here rather than under "advanced" — it is an
       - everyday setting with a visible effect on Home (see
       - HomeView.vue), not a diagnostic one like the log level. -->
      <div class="setting">
        <v-switch
          :model-value="recommendationsStore.enabled"
          color="primary"
          density="compact"
          hide-details
          :label="$t('settings.recommendations')"
          @update:model-value="recommendationsStore.setEnabled(!!$event)"
        />
        <p class="setting__hint">{{ $t('settings.recommendationsHint') }}</p>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { useRecommendationsStore } from '@/stores/recommendations'

/**
 * The library itself: forcing the server (or, on Jellyfin, Beacon's own
 * cache) to look for changes, and the toggle that decides whether Discover
 * seeds its recommendations from what is in there.
 *
 * The scan belongs to the library store rather than this component — it
 * outlives the page (see its startScan()), so these controls only read and
 * start it.
 */
export default {
  name: 'LibrarySection',
  created() {
    // A scan may already be running — one this app started before a
    // restart, or one somebody kicked off on the server itself. Asked
    // once, and only where the control that shows it exists.
    if (this.authStore.capabilities.libraryScan) void this.libraryStore.resumeScanIfRunning()
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    recommendationsStore() {
      return useRecommendationsStore()
    },
    /** What to call the media server in the text next to the scan button.
     * All three server types show that button (it is gated on being an
     * admin, not on which server it is), and it used to tell a Plex or
     * Jellyfin admin that Navidrome was about to scan their files. Same
     * three names the login screen offers. */
    serverName(): string {
      if (this.authStore.serverType === 'jellyfin') return this.$t('auth.serverTypeJellyfin')
      if (this.authStore.serverType === 'plex') return this.$t('auth.serverTypePlex')
      return this.$t('auth.serverTypeSubsonic')
    },
    scanning(): boolean {
      return this.libraryStore.scanning
    },
    scanCount(): number | null {
      return this.libraryStore.scanCount
    },
    scanPercent(): number | null {
      return this.libraryStore.scanPercent
    },
    scanLabel(): string {
      if (this.scanCount != null) return this.$t('settings.scanning', { count: this.scanCount })
      if (this.scanPercent != null) {
        return this.$t('settings.scanningPercent', { percent: this.scanPercent })
      }
      return this.$t('settings.scanningPlain')
    },
    refreshingLibrary() {
      return this.libraryStore.songScanProgress !== null
    },
    refreshProgressPercent() {
      const progress = this.libraryStore.songScanProgress
      if (!progress || !progress.total) return null
      return Math.min(100, Math.round((progress.loaded / progress.total) * 100))
    },
    refreshProgressLabel() {
      const progress = this.libraryStore.songScanProgress
      if (!progress) return ''
      return progress.total
        ? this.$t('settings.refreshingLibraryWithTotal', {
            loaded: progress.loaded,
            total: progress.total,
          })
        : this.$t('settings.refreshingLibrary', { loaded: progress.loaded })
    },
  },
  methods: {
    /** Hands the whole scan to the library store — see its startScan() for
     * why it lives there and not here. Only the "could not even start"
     * case is this section's to report; everything after that is announced
     * wherever the person happens to be by then. */
    async rescanLibrary() {
      try {
        await this.libraryStore.startScan()
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.rescanLibrary'),
          message: this.$t('settings.scanFailed'),
        })
        console.error('[settings] Failed to start library scan:', error)
      }
    },
    async refreshLibrary() {
      try {
        await this.libraryStore.refreshLibrary()
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.refreshLibrary'),
          message: this.$t('settings.libraryRefreshed', {
            count: this.libraryStore.allSongs.length,
          }),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.refreshLibrary'),
          message: this.$t('settings.refreshLibraryFailed'),
        })
        console.error('[settings] Failed to refresh library:', error)
      }
    },
  },
}
</script>
