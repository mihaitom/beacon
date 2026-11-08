<template>
  <!-- Persistent once the key is there: a stray click beside the dialog
     - would take it away for good. -->
  <v-dialog
    :model-value="modelValue"
    max-width="460"
    scrollable
    :persistent="!!newKey"
    @update:model-value="$emit('update:modelValue', $event)"
    @after-leave="reset"
  >
    <v-card v-if="newKey" class="beacon-dialog">
      <v-card-title>{{ $t('settings.deviceKeysShownTitle', { name: newKeyLabel }) }}</v-card-title>
      <v-card-text class="device-key-dialog__shown">
        <v-text-field
          :model-value="newKey"
          :label="$t('settings.deviceKeysKey')"
          readonly
          variant="solo-filled"
          spellcheck="false"
          hide-details
        >
          <template #append-inner>
            <v-icon
              :icon="copied === 'key' ? 'mdi-check' : 'mdi-content-copy'"
              :color="copied === 'key' ? 'success' : undefined"
              :title="$t('settings.deviceKeysCopy')"
              @click="copyKey"
            />
          </template>
        </v-text-field>
        <v-alert type="info" variant="tonal" density="compact">
          {{ $t(newKeyIsForApp ? 'settings.deviceKeysOnceApp' : 'settings.deviceKeysOnce') }}
        </v-alert>
        <div v-if="newKeyIsForApp" class="device-key-dialog__for-ai">
          <v-btn
            variant="tonal"
            :prepend-icon="copied === 'instructions' ? 'mdi-check' : 'mdi-robot-outline'"
            @click="copyInstructions"
          >
            {{ $t('settings.deviceKeysForAi') }}
          </v-btn>
          <p class="setting__hint">{{ $t('settings.deviceKeysForAiHint') }}</p>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t('common.close') }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <v-card v-else class="beacon-dialog">
      <v-card-title>{{ $t('settings.deviceKeysAdd') }}</v-card-title>
      <v-card-text>
        <choice-tiles v-model="kind" :options="kinds" :label="$t('settings.deviceKeysKind')" />
        <v-text-field
          v-model="label"
          :label="$t('settings.deviceKeysLabel')"
          :placeholder="
            $t(kind === 'app' ? 'settings.deviceKeysLabelHintApp' : 'settings.deviceKeysLabelHint')
          "
          variant="solo-filled"
          maxlength="100"
          hide-details
          class="device-key-dialog__name"
          @keyup.enter="create"
        />
        <template v-if="kind === 'desktop'">
          <v-switch
            v-model="shareApiKeys"
            :label="$t('settings.deviceKeysShareApi')"
            color="primary"
            density="compact"
            hide-details
            class="device-key-dialog__share"
          />
          <p class="setting__hint">{{ $t('settings.deviceKeysShareApiHint') }}</p>
        </template>
        <template v-else>
          <h3 class="eyebrow-label panel-title device-key-dialog__rights">
            {{ $t('settings.deviceKeysAppRights') }}
          </h3>
          <v-switch
            v-for="scope in appScopeList"
            :key="scope"
            v-model="appScopes"
            :value="scope"
            :label="$t(`settings.deviceKeysScope_${scope}`)"
            :disabled="scope === 'lyrics' && !appScopes.includes('now_playing')"
            color="primary"
            density="compact"
            hide-details
          />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-help-circle-outline"
          class="device-key-dialog__help"
          @click="$emitter.emit('openHelp', helpPage)"
        >
          {{ $t('settings.serverLinkDocs') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t('common.cancel') }}
        </v-btn>
        <v-btn color="primary" :loading="busy" :disabled="!canCreate" @click="create">
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
      // Unlike the key, there is no field on screen to copy this from by hand.
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
.device-key-dialog__name {
  margin-top: 16px;
}

.device-key-dialog__share {
  margin-top: 8px;
}

.device-key-dialog__rights {
  margin-top: 20px;
}

.device-key-dialog__shown {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* The tiles' and fields' left edge: the text button's padding would push its
 * icon in from it. */
.device-key-dialog__help {
  margin-left: -4px;
}
</style>
