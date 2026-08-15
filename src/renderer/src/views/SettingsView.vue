<template>
  <v-container max-width="600">
    <h1 class="page-title mb-4">{{ $t('settings.title') }}</h1>

    <v-card class="mb-4">
      <v-card-title>{{ $t('settings.connection') }}</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="serverUrl"
          :label="$t('auth.serverUrl')"
          variant="solo-filled"
          class="mb-2"
          readonly
        />
        <v-text-field
          v-model="username"
          :label="$t('auth.username')"
          variant="solo-filled"
          class="mb-2"
          readonly
        />

        <v-alert v-if="authStore.health" type="info" variant="tonal" density="compact" class="mb-2">
          {{
            $t('settings.healthLine', {
              ffmpeg: authStore.health.ffmpeg
                ? $t('settings.ffmpegFound')
                : $t('settings.ffmpegMissing'),
              navidrome: authStore.health.navidrome_configured
                ? $t('settings.yes')
                : $t('settings.no'),
            })
          }}
        </v-alert>

        <v-alert type="warning" variant="tonal" density="compact" class="mb-4">
          {{ $t('settings.internalUrlWarning') }}
        </v-alert>

        <v-select
          v-model="locale"
          :items="localeOptions"
          :label="$t('settings.language')"
          class="mb-4"
          variant="solo-filled"
          @update:model-value="onLocaleChange"
        />

        <p class="text-caption text-medium-emphasis mb-2">
          {{ $t('settings.changeConnectionHint') }}
        </p>
        <v-btn variant="text" color="error" @click="logout">{{ $t('settings.logout') }}</v-btn>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title>{{ $t('settings.libraryTitle') }}</v-card-title>
      <v-card-text>
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
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-title>{{ $t('settings.about') }}</v-card-title>
      <v-card-text>
        <v-btn variant="tonal" prepend-icon="mdi-star-circle-outline" @click="showReleaseNotes">
          {{ $t('settings.whatsNew') }}
        </v-btn>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import { getLocale, setLocale, type SupportedLocale } from '@/i18n'

// How often getScanStatus.view is polled while a scan is running — frequent
// enough that the live count feels responsive, not so frequent it hammers
// Navidrome for no real benefit (a scan takes at least several seconds even
// for a small library).
const SCAN_POLL_INTERVAL_MS = 2000

export default {
  name: 'SettingsView',
  data() {
    return {
      serverUrl: '',
      username: '',
      locale: getLocale(),
      scanning: false,
      // Navidrome's own running total of items scanned so far — only
      // meaningful while `scanning` is true.
      scanCount: 0,
      scanTimer: null as ReturnType<typeof setTimeout> | null,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    localeOptions() {
      return [
        { title: 'Deutsch', value: 'de' },
        { title: 'English', value: 'en' },
      ]
    },
  },
  created() {
    this.serverUrl = this.authStore.serverUrl
    this.username = this.authStore.username
  },
  beforeUnmount() {
    if (this.scanTimer) clearTimeout(this.scanTimer)
  },
  methods: {
    onLocaleChange(value: SupportedLocale) {
      setLocale(value)
    },
    async logout() {
      await this.authStore.logout()
      this.$router.push('/login')
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
      // A scan can add, remove, or re-tag tracks — without this, Beacon
      // would keep showing whatever it already had cached in memory until
      // the app restarts, same "missing tracks never appear" complaint
      // that prompted this feature in the first place.
      this.libraryStore.invalidateCache()
      this.$emitter.emit('toast', {
        level: 'success',
        title: this.$t('settings.rescanLibrary'),
        message: this.$t('settings.scanComplete', { count: this.scanCount }),
      })
    },
  },
}
</script>
