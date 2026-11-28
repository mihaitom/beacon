<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.audiomuseTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.audiomuseWhat') }}</p>

        <div class="status-row">
          <span class="status-dot" :class="available ? 'status-dot--ok' : 'status-dot--warn'" />
          <span class="setting__hint setting__hint--inline">{{ statusText }}</span>
        </div>

        <div class="audiomuse-row">
          <v-text-field
            v-model="urlInput"
            :label="$t('settings.audiomuseUrlLabel')"
            placeholder="http://audiomuse:8000"
            :disabled="busy || urlLent"
            :hint="urlHint"
            :persistent-hint="!!urlHint"
            variant="solo-filled"
            autocomplete="off"
            spellcheck="false"
            class="audiomuse-row__field"
            @keyup.enter="save"
          />
        </div>

        <div class="audiomuse-row">
          <v-text-field
            v-model="keyInput"
            :label="$t('settings.audiomuseKeyLabel')"
            :placeholder="
              settings?.key.configured ? $t('settings.apiKeySet') : $t('settings.apiKeyPlaceholder')
            "
            :disabled="busy"
            :hint="keyHint"
            :persistent-hint="!!keyHint"
            variant="solo-filled"
            autocomplete="off"
            spellcheck="false"
            class="audiomuse-row__field"
            @keyup.enter="save"
          />
          <quality-tips :lines="[$t('settings.audiomuseStep1'), $t('settings.audiomuseStep2')]" />
        </div>

        <div class="audiomuse-actions">
          <!-- Only what Settings stored can be removed here; a value from
           - the deployment or the paired server would stay in effect. -->
          <v-btn
            variant="text"
            rounded="pill"
            prepend-icon="mdi-help-circle-outline"
            @click="$emitter.emit('openHelp', 'faq/audiomuse')"
          >
            {{ $t('settings.audiomuseHelp') }}
          </v-btn>
          <v-btn v-if="removable" variant="text" rounded="pill" :disabled="busy" @click="remove">
            {{ $t('settings.audiomuseRemove') }}
          </v-btn>
          <v-spacer />
          <v-btn color="primary" rounded="pill" :loading="busy" :disabled="!changed" @click="save">
            {{ $t('common.save') }}
          </v-btn>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import {
  getAudioMuseSettings,
  saveAudioMuseSettings,
  type AudioMuseReason,
  type AudioMuseSettings,
} from '@/services/connect/audiomuse'
import { useAudioMuseStore } from '@/stores/audiomuse'
import QualityTips from './QualityTips.vue'

const REASON_KEYS: Record<AudioMuseReason, string> = {
  'not-configured': 'settings.audiomuseNotConfigured',
  unreachable: 'settings.audiomuseUnreachable',
  unauthorized: 'settings.audiomuseUnauthorized',
  'too-old': 'settings.audiomuseTooOld',
  'no-server': 'settings.audiomuseNoServer',
  failed: 'settings.audiomuseUnreachable',
}

/**
 * AudioMuse-AI's address and API token for the whole installation
 * (connect/core/audiomuse.py). Its own section rather than a row under API
 * keys: it needs an address as well, and its status is more than "a key is
 * set" - whether connect reaches it and finds this login's songs there.
 */
export default {
  name: 'AudioMuseSection',
  components: { QualityTips },
  data() {
    return {
      settings: null as AudioMuseSettings | null,
      urlInput: '',
      keyInput: '',
      busy: false,
    }
  },
  computed: {
    audiomuse() {
      return useAudioMuseStore()
    },
    available(): boolean {
      return this.audiomuse.available
    },
    statusText(): string {
      const status = this.audiomuse.status
      if (!status) return this.$t('settings.audiomuseChecking')
      if (status.available) {
        return this.$t('settings.audiomuseConnected', {
          version: status.version ?? '',
          server: status.server ?? '',
        })
      }
      return this.$t(REASON_KEYS[status.reason ?? 'not-configured'])
    },
    urlLent(): boolean {
      return !!this.settings?.urlFromServer
    },
    urlHint(): string {
      if (this.settings?.urlFromServer) return this.$t('settings.audiomuseFromServer')
      if (this.settings?.urlFromEnvironment) return this.$t('settings.apiKeyFromEnvironment')
      return ''
    },
    keyHint(): string {
      const key = this.settings?.key
      if (key?.fromServer) return this.$t('settings.apiKeyFromServer')
      if (key?.fromEnvironment) return this.$t('settings.apiKeyFromEnvironment')
      return ''
    },
    changed(): boolean {
      return this.urlInput.trim() !== (this.settings?.url ?? '') || !!this.keyInput.trim()
    },
    removable(): boolean {
      const settings = this.settings
      if (!settings) return false
      const ownUrl = !!settings.url && !settings.urlFromEnvironment && !settings.urlFromServer
      const ownKey =
        settings.key.configured && !settings.key.fromEnvironment && !settings.key.fromServer
      return ownUrl || ownKey
    },
  },
  created() {
    void this.load()
    this.$emitter.on('serverLinkSynced', this.reloadLent)
  },
  beforeUnmount() {
    this.$emitter.off('serverLinkSynced', this.reloadLent)
  },
  methods: {
    async load() {
      try {
        this.apply(await getAudioMuseSettings())
      } catch (error) {
        console.error('[settings] Failed to load the AudioMuse settings:', error)
      }
      await this.recheck()
    },
    /** A sync may have brought the server's address and token: shown
     * without reopening Settings, and checked at once - unless the field
     * is being edited. */
    async reloadLent() {
      if (this.busy || this.changed) return
      await this.load()
    },
    apply(settings: AudioMuseSettings) {
      this.settings = settings
      this.urlInput = settings.url
      this.keyInput = ''
    },
    async recheck() {
      this.audiomuse.reset()
      await this.audiomuse.ensure()
    },
    async save() {
      const change: { url?: string; key?: string } = {}
      if (this.urlInput.trim() !== (this.settings?.url ?? '')) change.url = this.urlInput
      if (this.keyInput.trim()) change.key = this.keyInput
      await this.store(change, this.$t('settings.audiomuseSaved'))
    },
    async remove() {
      await this.store({ url: '', key: '' }, this.$t('settings.audiomuseRemoved'))
    },
    async store(change: { url?: string; key?: string }, successMessage: string) {
      this.busy = true
      const title = this.$t('settings.audiomuseTitle')
      try {
        this.apply(await saveAudioMuseSettings(change))
        await this.recheck()
        this.$emitter.emit('toast', { level: 'success', title, message: successMessage })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title,
          message: this.$t('settings.audiomuseFailed'),
        })
        console.error('[settings] Failed to store the AudioMuse settings:', error)
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style scoped>
.audiomuse-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
}

.audiomuse-row__field {
  flex: 1;
  min-width: 0;
}

.audiomuse-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
