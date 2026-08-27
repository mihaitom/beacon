<template>
  <v-container max-width="600" class="settings-view">
    <h1 class="page-title mb-8">{{ $t('settings.title') }}</h1>

    <section class="mb-10">
      <h2 class="section-title mb-4">{{ $t('settings.account') }}</h2>

      <div class="account-strip">
        <div class="account-badge">
          <NavidromeIcon v-if="authStore.serverType === 'subsonic'" />
          <PlexIcon v-else-if="authStore.serverType === 'plex'" />
          <JellyfinIcon v-else />
        </div>
        <div class="account-info">
          <p class="account-info__url">{{ serverUrl }}</p>
          <p class="account-info__user text-medium-emphasis">{{ username }}</p>
        </div>
        <v-btn variant="text" color="error" size="small" @click="logout">
          {{ $t('settings.logout') }}
        </v-btn>
      </div>

      <v-select
        v-model="locale"
        :items="localeOptions"
        :label="$t('settings.language')"
        variant="solo-filled"
        class="mt-6"
        @update:model-value="onLocaleChange"
      />
    </section>

    <section class="mb-10">
      <h2 class="section-title mb-4">{{ $t('settings.playbackTitle') }}</h2>
      <p class="text-body-2 font-weight-medium mb-2">{{ $t('settings.replayGain') }}</p>
      <div class="segmented-control" role="radiogroup" :aria-label="$t('settings.replayGain')">
        <button
          v-for="option in replayGainOptions"
          :key="option.value"
          type="button"
          role="radio"
          class="segmented-control__option"
          :class="{ 'segmented-control__option--active': replayGainMode === option.value }"
          :aria-checked="replayGainMode === option.value"
          @click="replayGainMode = option.value"
        >
          {{ option.title }}
        </button>
      </div>
      <p class="text-caption text-medium-emphasis mt-3">
        {{ $t('settings.replayGainHint') }}
      </p>

      <p class="text-body-2 font-weight-medium mt-6 mb-2">{{ $t('settings.localQuality') }}</p>
      <div class="quality-row">
        <v-select
          :model-value="playbackStore.localQuality.format"
          :items="formatOptions"
          :label="$t('settings.qualityFormat')"
          variant="solo-filled"
          hide-details
          @update:model-value="playbackStore.setLocalQuality($event)"
        />
        <v-select
          v-if="playbackStore.localQuality.format !== 'original'"
          :model-value="playbackStore.localQuality.bitrate"
          :items="bitrateOptions(playbackStore.localQuality.format)"
          :label="$t('settings.qualityBitrate')"
          variant="solo-filled"
          hide-details
          @update:model-value="
            playbackStore.setLocalQuality(playbackStore.localQuality.format, $event)
          "
        />
      </div>
      <p class="text-caption text-medium-emphasis mt-3">
        {{ $t('settings.localQualityHint') }}
      </p>
      <p class="text-body-2 font-weight-medium mt-6 mb-2">{{ $t('settings.castQuality') }}</p>
      <div class="quality-row">
        <v-select
          :model-value="playbackStore.castQuality.format"
          :items="castFormatOptions"
          :label="$t('settings.qualityFormat')"
          variant="solo-filled"
          hide-details
          @update:model-value="playbackStore.setCastQuality($event)"
        />
        <v-select
          v-if="playbackStore.castQuality.format !== 'original'"
          :model-value="playbackStore.castQuality.bitrate"
          :items="bitrateOptions(playbackStore.castQuality.format)"
          :label="$t('settings.qualityBitrate')"
          variant="solo-filled"
          hide-details
          @update:model-value="
            playbackStore.setCastQuality(playbackStore.castQuality.format, $event)
          "
        />
      </div>
      <p class="text-caption text-medium-emphasis mt-3">
        {{ $t('settings.castQualityHint') }}
      </p>

      <template v-if="authStore.capabilities.songRadio">
        <p class="text-body-2 font-weight-medium mt-6 mb-2">{{ $t('settings.autoplay') }}</p>
        <v-select
          :model-value="autoplayStore.batchSize"
          :items="autoplayBatchSizeOptions"
          variant="solo-filled"
          hide-details
          @update:model-value="autoplayStore.setBatchSize($event)"
        />
        <p class="text-caption text-medium-emphasis mt-3">
          {{ $t('settings.autoplayHint') }}
        </p>
      </template>
    </section>

    <section v-if="authStore.capabilities.libraryScan" class="mb-10">
      <h2 class="section-title mb-4">{{ $t('settings.libraryTitle') }}</h2>
      <p class="text-body-2 text-medium-emphasis mb-4">
        {{ $t('settings.libraryScanHint') }}
      </p>
      <v-btn
        color="primary"
        prepend-icon="mdi-refresh"
        :loading="scanning"
        :disabled="scanning"
        @click="rescanLibrary"
      >
        {{
          scanning ? $t('settings.scanning', { count: scanCount }) : $t('settings.rescanLibrary')
        }}
      </v-btn>
    </section>

    <!-- Jellyfin has no server-side scan-trigger of its own (see
     - capabilities.libraryScan) — this instead forces Beacon's own cached
     - view of the library to refetch now, rather than waiting for
     - CACHE_TTL_MS. Shows real progress since a large Jellyfin library can
     - take a couple of minutes (see stores/library.ts's refreshLibrary()). -->
    <section v-else-if="authStore.serverType === 'jellyfin'" class="mb-10">
      <h2 class="section-title mb-4">{{ $t('settings.libraryTitle') }}</h2>
      <p class="text-body-2 text-medium-emphasis mb-4">
        {{ $t('settings.libraryRefreshHint') }}
      </p>
      <v-btn
        color="primary"
        prepend-icon="mdi-refresh"
        :loading="refreshingLibrary"
        :disabled="refreshingLibrary"
        @click="refreshLibrary"
      >
        {{ refreshingLibrary ? refreshProgressLabel : $t('settings.refreshLibrary') }}
      </v-btn>
      <v-progress-linear
        v-if="refreshingLibrary"
        class="mt-3"
        :indeterminate="refreshProgressPercent === null"
        :model-value="refreshProgressPercent ?? undefined"
        color="primary"
        height="6"
        rounded
      />
    </section>

    <section class="mb-10">
      <h2 class="section-title mb-4">{{ $t('settings.storageTitle') }}</h2>
      <p class="text-body-2 text-medium-emphasis mb-4">
        {{ $t('settings.clearCacheHint') }}
      </p>
      <v-btn variant="tonal" prepend-icon="mdi-broom" @click="clearCache">
        {{ $t('settings.clearCache') }}
      </v-btn>

      <p class="text-body-2 text-medium-emphasis mt-6 mb-4">
        {{ $t('settings.resetAirplayHint') }}
      </p>
      <v-btn
        variant="tonal"
        prepend-icon="mdi-cast-off"
        :loading="resettingAirplay"
        @click="resetAirplayPairings"
      >
        {{ $t('settings.resetAirplay') }}
      </v-btn>
    </section>

    <section class="mb-10">
      <h2 class="section-title mb-4">{{ $t('settings.advancedTitle') }}</h2>
      <p class="text-body-2 text-medium-emphasis mb-4">
        {{ $t('settings.logLevelHint') }}
      </p>
      <v-select
        v-model="logLevel"
        :items="logLevelOptions"
        :label="$t('settings.logLevel')"
        :loading="logLevelBusy"
        :disabled="logLevelBusy || logLevel === null"
        variant="solo-filled"
        @update:model-value="onLogLevelChange"
      />

      <v-switch
        :model-value="recommendationsStore.enabled"
        color="primary"
        density="compact"
        hide-details
        class="mt-4"
        :label="$t('settings.recommendations')"
        @update:model-value="recommendationsStore.setEnabled(!!$event)"
      />
      <p class="text-caption text-medium-emphasis mt-2">
        {{ $t('settings.recommendationsHint') }}
      </p>
    </section>

    <section>
      <h2 class="section-title mb-4">{{ $t('settings.about') }}</h2>
      <div class="about-actions">
        <v-btn variant="tonal" prepend-icon="mdi-star-circle-outline" @click="showReleaseNotes">
          {{ $t('settings.whatsNew') }}
        </v-btn>
        <!-- The "?" key opens the same dialog, but nothing on screen says
         - so — this is where someone who has never pressed it finds out
         - the shortcuts exist at all. -->
        <v-btn variant="tonal" prepend-icon="mdi-keyboard-outline" @click="showShortcuts">
          {{ $t('shortcuts.title') }}
        </v-btn>
      </div>
      <div class="status-row mt-4">
        <span class="status-dot" :class="ffmpegFound ? 'status-dot--ok' : 'status-dot--warn'" />
        <span class="text-caption text-medium-emphasis">
          {{ ffmpegFound ? $t('settings.ffmpegFound') : $t('settings.ffmpegMissing') }}
        </span>
      </div>
      <p class="text-caption text-medium-emphasis mt-1">
        {{ $t('settings.version', { version: appVersion }) }}
      </p>
      <v-alert
        v-if="updateStore.available"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-3"
      >
        {{ $t('settings.updateAvailable', { version: updateStore.latestVersion }) }}
        <a
          v-if="updateStore.releaseUrl"
          :href="updateStore.releaseUrl"
          target="_blank"
          rel="noopener"
          class="update-link"
        >
          {{ $t('settings.updateAvailableLink') }}
        </a>
      </v-alert>
    </section>
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useConnectStore } from '@/stores/connect'
import { clearLyricsCache } from '@/stores/lyrics'
import { getLocale, setLocale, type SupportedLocale } from '@/i18n'
import { getLogLevel, setLogLevel, type LogLevel } from '@/services/connect/logLevel'
import { useRecommendationsStore } from '@/stores/recommendations'
import { AUTOPLAY_BATCH_SIZE_OPTIONS, useAutoplayStore } from '@/stores/autoplay'
import { useUpdateStore } from '@/stores/update'
import type { ReplayGainMode } from '@/services/replayGain'
import {
  BITRATES,
  CAST_FORMATS,
  LOCAL_FORMATS,
  type StreamFormat,
  type TranscodeFormat,
} from '@/services/streamQuality'
import NavidromeIcon from '@/components/auth/NavidromeIcon.vue'
import JellyfinIcon from '@/components/auth/JellyfinIcon.vue'
import PlexIcon from '@/components/auth/PlexIcon.vue'
import packageJson from '../../../../package.json'

// How often getScanStatus.view is polled while a scan is running — frequent
// enough that the live count feels responsive, not so frequent it hammers
// Navidrome for no real benefit (a scan takes at least several seconds even
// for a small library).
const SCAN_POLL_INTERVAL_MS = 2000

export default {
  name: 'SettingsView',
  components: { NavidromeIcon, JellyfinIcon, PlexIcon },
  data() {
    return {
      serverUrl: '',
      username: '',
      locale: getLocale(),
      appVersion: packageJson.version,
      scanning: false,
      // Navidrome's own running total of items scanned so far — only
      // meaningful while `scanning` is true.
      scanCount: 0,
      scanTimer: null as ReturnType<typeof setTimeout> | null,
      resettingAirplay: false,
      // null until loadLogLevel() (created() below) resolves — the
      // v-select stays disabled/loading until then rather than guessing a
      // default that might not match what's actually configured backend-side.
      logLevel: null as LogLevel | null,
      logLevelBusy: false,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    connectStore() {
      return useConnectStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    playbackStore() {
      return usePlaybackStore()
    },
    updateStore() {
      return useUpdateStore()
    },
    recommendationsStore() {
      return useRecommendationsStore()
    },
    autoplayStore() {
      return useAutoplayStore()
    },
    // Defaults to true (no warning dot) while health hasn't loaded yet —
    // ffmpeg being genuinely missing is rare enough that a false negative
    // for a split second on page load isn't worth the flicker.
    ffmpegFound() {
      return this.authStore.health?.ffmpeg ?? true
    },
    replayGainMode: {
      get(): ReplayGainMode {
        return this.playbackStore.replayGainMode
      },
      set(mode: ReplayGainMode) {
        this.playbackStore.setReplayGainMode(mode)
      },
    },
    replayGainOptions(): { title: string; value: ReplayGainMode }[] {
      return [
        { title: this.$t('settings.replayGainOff'), value: 'off' },
        { title: this.$t('settings.replayGainTrack'), value: 'song' },
        { title: this.$t('settings.replayGainAlbum'), value: 'album' },
      ]
    },
    /** Both lists come from services/streamQuality.ts rather than being
     * written out here — which formats each side can offer is a fact about
     * the encoders and the seeking, not a UI decision, and it's explained
     * where it's decided. */
    formatOptions(): { title: string; value: StreamFormat }[] {
      return LOCAL_FORMATS.map((value) => ({ title: this.formatLabel(value), value }))
    },
    castFormatOptions(): { title: string; value: StreamFormat }[] {
      return CAST_FORMATS.map((value) => ({ title: this.formatLabel(value), value }))
    },
    autoplayBatchSizeOptions() {
      return AUTOPLAY_BATCH_SIZE_OPTIONS.map((count) => ({
        title: this.$t('settings.autoplayBatchSizeItem', { count }),
        value: count,
      }))
    },
    localeOptions() {
      return [
        { title: 'Deutsch', value: 'de' },
        { title: 'English', value: 'en' },
        { title: 'Español', value: 'es' },
        { title: 'Français', value: 'fr' },
        { title: 'Italiano', value: 'it' },
      ]
    },
    logLevelOptions() {
      return [
        { title: this.$t('settings.logLevelTrace'), value: 'TRACE' },
        { title: this.$t('settings.logLevelDebug'), value: 'DEBUG' },
        { title: this.$t('settings.logLevelInfo'), value: 'INFO' },
        { title: this.$t('settings.logLevelWarning'), value: 'WARNING' },
        { title: this.$t('settings.logLevelError'), value: 'ERROR' },
      ]
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
  created() {
    this.serverUrl = this.authStore.serverUrl
    this.username = this.authStore.username
    void this.loadLogLevel()
  },
  beforeUnmount() {
    if (this.scanTimer) clearTimeout(this.scanTimer)
  },
  methods: {
    formatLabel(format: StreamFormat): string {
      return format === 'original' ? this.$t('settings.qualityOriginal') : format.toUpperCase()
    },
    bitrateOptions(format: TranscodeFormat): { title: string; value: number }[] {
      return BITRATES[format].map((value) => ({
        title: this.$t('settings.qualityBitrateItem', { value }),
        value,
      }))
    },
    onLocaleChange(value: SupportedLocale) {
      setLocale(value)
    },
    // Reads back whatever's actually configured backend-side (Settings'
    // own last choice, or the DEBUG env var fallback on a deployment that's
    // never touched this before — see core/log_level.py) rather than
    // guessing a default that could silently disagree with it.
    async loadLogLevel() {
      try {
        const { level } = await getLogLevel()
        this.logLevel = level
      } catch (error) {
        console.error('[settings] Failed to load log level:', error)
      }
    },
    async onLogLevelChange(value: LogLevel) {
      this.logLevelBusy = true
      try {
        await setLogLevel(value)
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.logLevel'),
          message: this.$t('settings.logLevelChanged'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.logLevel'),
          message: this.$t('settings.logLevelChangeFailed'),
        })
        console.error('[settings] Failed to set log level:', error)
        void this.loadLogLevel() // re-sync the dropdown with what's actually active
      } finally {
        this.logLevelBusy = false
      }
    },
    async logout() {
      await this.authStore.logout()
      this.$router.push('/login')
    },
    showShortcuts() {
      this.$emitter.emit('toggleKeyboardShortcuts')
    },
    showReleaseNotes() {
      this.$emitter.emit('openReleaseNotes')
    },
    async rescanLibrary() {
      this.scanning = true
      this.scanCount = 0
      try {
        const status = await this.libraryStore.client().startScan()
        this.scanCount = status.count
      } catch (error) {
        this.scanning = false
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.rescanLibrary'),
          message: this.$t('settings.scanFailed'),
        })
        console.error('[settings] Failed to start library scan:', error)
        return
      }
      void this.pollScanStatus()
    },
    // Navidrome's Subsonic extension has no push notification for "scan
    // finished" — polling getScanStatus.view until `scanning` flips back to
    // false is the only way to know. Schedules its own next tick via
    // setTimeout rather than setInterval, so a slow response can't ever
    // stack a second poll on top of one still in flight.
    async pollScanStatus() {
      let status
      try {
        status = await this.libraryStore.client().getScanStatus()
      } catch (error) {
        this.scanning = false
        console.error('[settings] Failed to poll library scan status:', error)
        return
      }
      this.scanCount = status.count
      if (status.scanning) {
        this.scanTimer = setTimeout(() => this.pollScanStatus(), SCAN_POLL_INTERVAL_MS)
        return
      }
      this.scanning = false
      // A scan can add, remove, or re-tag songs — without this, Beacon
      // would keep showing whatever it already had cached in memory until
      // the app restarts, same "missing songs never appear" complaint
      // that prompted this feature in the first place.
      this.libraryStore.invalidateCache()
      this.$emitter.emit('toast', {
        level: 'success',
        title: this.$t('settings.rescanLibrary'),
        message: this.$t('settings.scanComplete', { count: this.scanCount }),
      })
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
    // Distinct from rescanLibrary()/refreshLibrary() above — those ask the
    // *server* to look for actual changes; this just throws away Beacon's
    // own locally-cached copies (library, lyrics) so the next view that
    // needs them fetches fresh, without necessarily implying anything on
    // the server side has changed. Waveforms aren't cached at all anymore
    // (see services/connect/waveform.ts) — a fresh decode is well under a
    // second, not worth keeping a cache around for. Both remaining caches
    // clear themselves synchronously — nothing here to await.
    clearCache() {
      this.libraryStore.invalidateCache()
      clearLyricsCache()
      this.$emitter.emit('toast', {
        level: 'success',
        title: this.$t('settings.clearCache'),
        message: this.$t('settings.cacheCleared'),
      })
    },
    // Forgets every paired AirPlay device's stored credentials (see
    // delivery/credentials.py) — each one needs pairing again on next use,
    // same as unpairing them one by one from the device picker
    // (ConnectDevicePicker.vue) would, just in bulk. Doesn't touch anything
    // Sonos/Chromecast/DLNA — those have no pairing step of their own.
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

<style scoped>
/* Format and bitrate side by side, with the format wider — it carries the
 * actual decision, while the bitrate is a number that needs no room. Wraps
 * on a narrow window (the mobile web build) instead of squeezing both into
 * something unreadable. */
.quality-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.quality-row > :first-child {
  flex: 2 1 180px;
}

.quality-row > :last-child:not(:first-child) {
  flex: 1 1 120px;
}

/* Echoes ServerLoginView.vue's lit account badge — the same signal that
 * confirmed which server you signed into now confirms who you're signed in
 * as, a deliberate bookend rather than a plain read-only form field. */
.account-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(255, 255, 255, 0.02);
}

.account-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 22px;
  flex-shrink: 0;
  background: rgba(var(--v-theme-primary), 0.12);
  box-shadow: 0 0 16px rgba(var(--v-theme-primary), 0.2);
}

.account-info {
  flex: 1;
  min-width: 0;
}

.account-info__url {
  font-weight: 600;
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-info__user {
  font-size: 0.8rem;
  margin-top: 2px;
}

/* Same tab-group language as ServerLoginView.vue's Password/Quick Connect
 * switch — a three-way choice reads better as one deliberate control than
 * as a dropdown menu. */
.segmented-control {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.segmented-control__option {
  flex: 1;
  padding: 8px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.segmented-control__option:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.segmented-control__option--active {
  background: rgba(245, 169, 78, 0.12);
  color: #fdf6ec;
  font-weight: 600;
}

/* A small lit/unlit signal rather than a full-width alert banner — same
 * "beacon" idea as everything else here, just dialed down to the size the
 * fact actually deserves (ffmpeg being present is the normal case). */
.about-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot--ok {
  background: rgb(var(--v-theme-success));
  box-shadow: 0 0 6px 1px rgba(95, 180, 137, 0.5);
}

.status-dot--warn {
  background: rgb(var(--v-theme-warning));
  box-shadow: 0 0 6px 1px rgba(242, 169, 59, 0.5);
}

.update-link {
  margin-left: 0.4em;
  font-weight: 600;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
