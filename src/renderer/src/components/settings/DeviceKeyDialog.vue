<template>
  <!-- Persistent once the key is there: a stray click beside the dialog
     - would take it away for good. -->
  <v-dialog
    :model-value="modelValue"
    max-width="480"
    scrollable
    :persistent="!!newKey"
    @update:model-value="$emit('update:modelValue', $event)"
    @after-leave="reset"
  >
    <v-card v-if="newKey" class="device-key-dialog beacon-dialog">
      <v-card-title class="device-key-dialog__title">
        {{ $t('settings.deviceKeysShownTitle', { name: newKeyLabel }) }}
      </v-card-title>
      <v-card-text class="device-key-dialog__body">
        <div class="beacon-panel device-key-dialog__key">
          <code class="device-key-dialog__secret">{{ newKey }}</code>
          <v-btn
            color="primary"
            variant="flat"
            rounded="pill"
            :prepend-icon="copied === 'key' ? 'mdi-check' : 'mdi-content-copy'"
            @click="copyKey"
          >
            {{ $t('settings.deviceKeysCopy') }}
          </v-btn>
        </div>
        <p class="device-key-dialog__once text-body-medium">
          <v-icon icon="mdi-alert-circle-outline" color="primary" size="20" />
          <span>
            {{ $t(newKeyIsForApp ? 'settings.deviceKeysOnceApp' : 'settings.deviceKeysOnce') }}
          </span>
        </p>
        <div v-if="newKeyIsForApp" class="device-key-dialog__for-ai">
          <v-btn
            variant="tonal"
            rounded="pill"
            :prepend-icon="copied === 'instructions' ? 'mdi-check' : 'mdi-robot-outline'"
            @click="copyInstructions"
          >
            {{ $t('settings.deviceKeysForAi') }}
          </v-btn>
          <p class="text-body-small text-medium-emphasis">
            {{ $t('settings.deviceKeysForAiHint') }}
          </p>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t('common.close') }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <v-card v-else class="device-key-dialog beacon-dialog">
      <v-card-title class="device-key-dialog__title device-key-dialog__head">
        <span>{{ $t('settings.deviceKeysAdd') }}</span>
        <v-btn
          icon="mdi-help-circle-outline"
          variant="text"
          density="comfortable"
          :title="$t('settings.serverLinkDocs')"
          class="device-key-dialog__help"
          @click="$emitter.emit('openHelp', helpPage)"
        />
      </v-card-title>
      <v-card-text class="device-key-dialog__body">
        <choice-tiles
          v-model="kind"
          :options="kinds"
          :label="$t('settings.deviceKeysKind')"
          class="device-key-dialog__kinds"
        />
        <v-text-field
          v-model="label"
          :label="$t('settings.deviceKeysLabel')"
          :placeholder="
            $t(kind === 'app' ? 'settings.deviceKeysLabelHintApp' : 'settings.deviceKeysLabelHint')
          "
          variant="solo-filled"
          maxlength="100"
          hide-details
          @keyup.enter="create"
        />
        <div v-if="kind === 'desktop'" class="beacon-panel beacon-panel--flush">
          <label class="device-key-dialog__row">
            <span class="device-key-dialog__row-text">
              <span class="text-body-medium">{{ $t('settings.deviceKeysShareApi') }}</span>
              <span class="text-body-small text-medium-emphasis">
                {{ $t('settings.deviceKeysShareApiHint') }}
              </span>
            </span>
            <v-switch
              v-model="shareApiKeys"
              color="primary"
              density="compact"
              hide-details
              class="device-key-dialog__switch"
            />
          </label>
        </div>
        <section v-else>
          <h3 class="eyebrow-label panel-title">{{ $t('settings.deviceKeysAppRights') }}</h3>
          <div class="beacon-panel beacon-panel--flush">
            <label
              v-for="scope in appScopeList"
              :key="scope"
              class="device-key-dialog__row"
              :class="{ 'device-key-dialog__row--locked': scopeLocked(scope) }"
            >
              <span class="text-body-medium device-key-dialog__row-text">
                {{ $t(`settings.deviceKeysScope_${scope}`) }}
              </span>
              <v-switch
                v-model="appScopes"
                :value="scope"
                :disabled="scopeLocked(scope)"
                color="primary"
                density="compact"
                hide-details
                class="device-key-dialog__switch"
              />
            </label>
          </div>
        </section>
      </v-card-text>
      <v-card-actions class="device-key-dialog__actions">
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t('common.cancel') }}
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          rounded="pill"
          :slim="false"
          :loading="busy"
          :disabled="!canCreate"
          @click="create"
        >
          {{ $t('settings.deviceKeysCreate') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import ChoiceTiles, { type ChoiceTile } from '@/components/ChoiceTiles.vue'
import { appKeyInstructions } from '@/services/connect/appKeyInstructions'
import {
  APP_SCOPES,
  createDeviceKey,
  type AppScope,
  type DeviceKeyScope,
} from '@/services/connect/serverLink'

export default {
  name: 'DeviceKeyDialog',
  components: { ChoiceTiles },
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ['update:modelValue', 'created'],
  data() {
    return {
      label: '',
      kind: 'desktop' as 'desktop' | 'app',
      shareApiKeys: false,
      appScopes: [] as AppScope[],
      appScopeList: APP_SCOPES,
      busy: false,
      /** Only right after creating: the key is never sent again. */
      newKey: '',
      newKeyLabel: '',
      newKeyScopes: [] as DeviceKeyScope[],
      copied: '' as '' | 'key' | 'instructions',
      copiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    kinds(): ChoiceTile[] {
      return [
        {
          value: 'desktop',
          icon: 'mdi-laptop',
          name: this.$t('settings.deviceKeysKindDesktop'),
          hint: this.$t('settings.deviceKeysKindDesktopHint'),
        },
        {
          value: 'app',
          icon: 'mdi-application-braces-outline',
          name: this.$t('settings.deviceKeysKindApp'),
          hint: this.$t('settings.deviceKeysKindAppHint'),
        },
      ]
    },
    /** Lyrics are only those of the song playing now, so they go with it. */
    chosenScopes(): DeviceKeyScope[] {
      if (this.kind === 'desktop') return this.shareApiKeys ? ['sync', 'api_keys'] : ['sync']
      return this.appScopes.includes('now_playing')
        ? this.appScopes
        : this.appScopes.filter((scope) => scope !== 'lyrics')
    },
    helpPage(): string {
      return this.kind === 'app' ? 'faq/apps-and-api' : 'guides/desktop-and-server'
    },
    canCreate(): boolean {
      return !this.busy && !!this.label.trim() && this.chosenScopes.length > 0
    },
    newKeyIsForApp(): boolean {
      return !this.newKeyScopes.includes('sync')
    },
  },
  watch: {
    // Rights are confirmed key by key, so nothing carries over to the next.
    modelValue(open: boolean) {
      if (open) this.reset()
    },
  },
  beforeUnmount() {
    clearTimeout(this.copiedTimer)
  },
  methods: {
    scopeLocked(scope: AppScope): boolean {
      return scope === 'lyrics' && !this.appScopes.includes('now_playing')
    },
    reset() {
      this.label = ''
      this.kind = 'desktop'
      this.shareApiKeys = false
      this.appScopes = []
      this.newKey = ''
      this.newKeyLabel = ''
      this.newKeyScopes = []
      this.copied = ''
    },
    async create() {
      if (!this.canCreate) return
      this.busy = true
      try {
        const { key, ...entry } = await createDeviceKey(this.label.trim(), this.chosenScopes)
        this.newKey = key
        this.newKeyLabel = entry.label
        this.newKeyScopes = entry.scopes
        this.$emit('created', { ...entry, last_used_at: null, active: false })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.deviceKeysTitle'),
          message: this.$t('settings.deviceKeysFailed'),
        })
        console.error('[settings] Device key request failed:', error)
      } finally {
        this.busy = false
      }
    },
    /** navigator.clipboard is absent on plain http, so this can fail there. */
    async copy(text: string, what: 'key' | 'instructions'): Promise<boolean> {
      try {
        await navigator.clipboard.writeText(text)
      } catch (error) {
        console.error('[settings] Failed to copy:', error)
        return false
      }
      clearTimeout(this.copiedTimer)
      this.copied = what
      this.copiedTimer = setTimeout(() => {
        this.copied = ''
      }, 2000)
      return true
    },
    async copyKey() {
      await this.copy(this.newKey, 'key')
    },
    async copyInstructions() {
      const origin = window.location.origin
      if (await this.copy(appKeyInstructions(origin, this.newKeyScopes), 'instructions')) return
      // Unlike the key, there is nothing on screen to copy this from by hand.
      this.$emitter.emit('toast', {
        level: 'error',
        title: this.$t('settings.deviceKeysTitle'),
        message: this.$t('settings.deviceKeysForAiFailed', {
          url: `${origin}/device-link/v1/openapi.json`,
        }),
      })
    },
  },
}
</script>

<style scoped>
.device-key-dialog.v-card {
  border-radius: 16px;
}

.device-key-dialog__title {
  padding-top: 20px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.device-key-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.device-key-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-top: 12px;
  padding-bottom: 8px;
}

/* Two columns leave a phone's tiles a word per line. */
@media (max-width: 480px) {
  .device-key-dialog__kinds.choice-tiles.v-btn-toggle {
    grid-template-columns: 1fr;
  }
}

.device-key-dialog__row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 44px;
  padding: 2px 14px 2px 16px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.device-key-dialog__row + .device-key-dialog__row {
  border-top: 1px solid var(--beacon-hairline);
}

.device-key-dialog__row:hover {
  background: var(--beacon-hover);
}

.device-key-dialog__row--locked {
  cursor: default;
  color: rgba(var(--v-theme-on-surface), var(--v-disabled-opacity));
}

.device-key-dialog__row--locked:hover {
  background: none;
}

.device-key-dialog__row-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding-block: 6px;
}

.device-key-dialog__switch.v-input {
  flex: none;
}

.device-key-dialog__actions {
  padding: 8px 24px 20px;
}

.device-key-dialog__key {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
}

/* Selected whole at a click: on plain http the browser has no clipboard for
 * the button to use, and this is the only way to get the key out. */
.device-key-dialog__secret {
  font-family: monospace;
  font-size: 0.875rem;
  line-height: 1.6;
  word-break: break-all;
  user-select: all;
}

.device-key-dialog__once {
  display: flex;
  gap: 10px;
}

.device-key-dialog__once .v-icon {
  flex: none;
}

.device-key-dialog__for-ai {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding-top: 20px;
  border-top: 1px solid var(--beacon-hairline);
}
</style>
