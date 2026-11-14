<template>
  <section v-if="source?.may_configure" class="settings-section">
    <h2 class="section-title">{{ $t('externalSource.settingsTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('externalSource.settingsWhat') }}</p>

        <v-text-field
          v-model="name"
          :label="$t('externalSource.name')"
          :placeholder="$t('externalSource.namePlaceholder')"
          variant="solo-filled"
          density="compact"
          maxlength="60"
          hide-details="auto"
          class="external-source__field"
        />
        <v-text-field
          v-model="baseUrl"
          :label="$t('externalSource.address')"
          placeholder="http://192.168.1.20:8800"
          variant="solo-filled"
          density="compact"
          spellcheck="false"
          hide-details="auto"
          class="external-source__field"
        />
        <v-text-field
          v-model="token"
          :label="$t('externalSource.token')"
          :placeholder="
            source?.has_token ? $t('externalSource.tokenKept') : $t('externalSource.tokenNone')
          "
          type="password"
          autocomplete="off"
          variant="solo-filled"
          density="compact"
          hide-details="auto"
          class="external-source__field"
        />

        <div v-if="probe" class="status-row">
          <span class="status-dot" :class="probe.ok ? 'status-dot--ok' : 'status-dot--warn'" />
          <span class="setting__hint setting__hint--inline">
            {{
              probe.ok
                ? $t('externalSource.reachable', { name: probe.name || name })
                : $t('externalSource.unreachable', { reason: probe.error })
            }}
          </span>
        </div>

        <div class="external-source__actions">
          <v-btn
            variant="text"
            prepend-icon="mdi-help-circle-outline"
            @click="$emitter.emit('openHelp', 'faq/external-sources')"
          >
            {{ $t('externalSource.help') }}
          </v-btn>
          <v-btn
            variant="text"
            :prepend-icon="instructionsCopied ? 'mdi-check' : 'mdi-robot-outline'"
            @click="copyInstructions"
          >
            {{ $t('externalSource.copyInstructions') }}
          </v-btn>
          <v-btn v-if="source?.configured" variant="text" :disabled="busy" @click="remove">
            {{ $t('externalSource.remove') }}
          </v-btn>
          <v-spacer />
          <v-btn color="primary" :loading="busy" :disabled="busy || !canSave" @click="save">
            {{ $t('externalSource.save') }}
          </v-btn>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import {
  externalSourceInstructions,
  probeExternalSource,
  removeExternalSource,
  saveExternalSource,
  type ExternalSourceProbe,
} from '@/services/connect/externalSource'
import { connectErrorMessage } from '@/services/connect/errorMessage'
import { useExternalSourceStore } from '@/stores/externalSource'

/** Where the external source's app lives (docs/plans/external-source.md).
 * Only for whoever may change it: an admin on a server, anyone on the
 * desktop app - connect decides, this only follows `may_configure`. */
export default {
  name: 'ExternalSourceSection',
  data() {
    return {
      name: '',
      baseUrl: '',
      /** Empty keeps the stored one; the stored token is never sent back. */
      token: '',
      busy: false,
      probe: null as ExternalSourceProbe | null,
      instructionsCopied: false,
      copiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    store() {
      return useExternalSourceStore()
    },
    source() {
      return this.store.source
    },
    canSave(): boolean {
      return !!this.name.trim() && !!this.baseUrl.trim()
    },
  },
  async created() {
    await this.store.load()
    this.fill()
    if (this.source?.configured && this.source.may_configure) {
      try {
        this.probe = await probeExternalSource()
      } catch {
        this.probe = null
      }
    }
  },
  beforeUnmount() {
    clearTimeout(this.copiedTimer)
  },
  methods: {
    fill() {
      this.name = this.source?.name ?? ''
      this.baseUrl = this.source?.base_url ?? ''
      this.token = ''
    },
    async save() {
      this.busy = true
      try {
        const { probe, ...source } = await saveExternalSource({
          name: this.name,
          base_url: this.baseUrl,
          ...(this.token ? { token: this.token } : {}),
        })
        this.store.set(source)
        this.probe = probe
        this.fill()
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async remove() {
      this.busy = true
      try {
        this.store.set(await removeExternalSource())
        this.probe = null
        this.fill()
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async copyInstructions() {
      try {
        await navigator.clipboard.writeText(externalSourceInstructions())
      } catch (error) {
        console.error('[settings] Failed to copy:', error)
        return
      }
      clearTimeout(this.copiedTimer)
      this.instructionsCopied = true
      this.copiedTimer = setTimeout(() => {
        this.instructionsCopied = false
      }, 2000)
    },
    toastError(error: unknown) {
      this.$emitter.emit('toast', {
        level: 'error',
        title: this.$t('externalSource.settingsTitle'),
        message: connectErrorMessage(error).message,
      })
    },
  },
}
</script>

<style scoped>
.external-source__field {
  margin-top: 12px;
}

.external-source__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
