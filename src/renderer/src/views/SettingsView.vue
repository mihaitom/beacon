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
        <v-text-field
          v-model="connectUrl"
          :label="$t('auth.connectBackendUrl')"
          variant="solo-filled"
          class="mb-2"
        />
        <v-text-field
          v-model="connectToken"
          :label="$t('settings.connectToken')"
          variant="solo-filled"
          class="mb-2"
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
          class="mb-2"
          variant="solo-filled"
          @update:model-value="onLocaleChange"
        />

        <v-btn color="primary" class="mr-2" :loading="saving" @click="saveConnectSettings">
          {{ $t('common.save') }}
        </v-btn>
        <v-btn variant="text" color="error" @click="logout">{{ $t('settings.logout') }}</v-btn>
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
import { getLocale, setLocale, type SupportedLocale } from '@/i18n'

export default {
  name: 'SettingsView',
  data() {
    return {
      serverUrl: '',
      username: '',
      connectUrl: '',
      connectToken: '',
      saving: false,
      locale: getLocale(),
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
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
    this.connectUrl = this.authStore.connectUrl
    this.connectToken = this.authStore.connectToken
  },
  methods: {
    onLocaleChange(value: SupportedLocale) {
      setLocale(value)
    },
    async saveConnectSettings() {
      this.saving = true
      try {
        await this.authStore.updateConnectSettings({
          connectUrl: this.connectUrl,
          connectToken: this.connectToken,
        })
      } finally {
        this.saving = false
      }
    },
    async logout() {
      await this.authStore.logout()
      this.$router.push('/login')
    },
    showReleaseNotes() {
      this.$emitter.emit('openReleaseNotes')
    },
  },
}
</script>
