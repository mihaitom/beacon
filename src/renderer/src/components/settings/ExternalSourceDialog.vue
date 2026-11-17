<template>
  <v-dialog
    :model-value="modelValue"
    max-width="480"
    scrollable
    @update:model-value="$emit('update:modelValue', $event)"
    @after-leave="probe = null"
  >
    <v-card class="beacon-dialog external-source-dialog">
      <v-card-title class="external-source-dialog__head">
        <span>{{ $t(editing ? 'externalSource.editTitle' : 'externalSource.addTitle') }}</span>
        <v-btn
          icon="mdi-help-circle-outline"
          variant="text"
          density="comfortable"
          :title="$t('externalSource.help')"
          @click="$emitter.emit('openHelp', 'faq/external-sources')"
        />
      </v-card-title>
      <v-card-text class="external-source-dialog__body">
        <v-text-field
          v-model="name"
          :label="$t('externalSource.name')"
          :placeholder="$t('externalSource.namePlaceholder')"
          variant="solo-filled"
          maxlength="60"
          hide-details="auto"
        />

        <div>
          <p class="eyebrow-label external-source-dialog__label">
            {{ $t('externalSource.icon') }}
          </p>
          <v-item-group v-model="icon" mandatory class="external-source-dialog__icons">
            <v-item
              v-for="choice in icons"
              :key="choice"
              v-slot="{ isSelected, toggle }"
              :value="choice"
            >
              <v-btn
                :icon="choice"
                :variant="isSelected ? 'flat' : 'text'"
                :color="isSelected ? 'primary' : undefined"
                :aria-pressed="isSelected"
                :aria-label="choice"
                @click="toggle"
              />
            </v-item>
          </v-item-group>
        </div>

        <v-text-field
          v-model="baseUrl"
          :label="$t('externalSource.address')"
          placeholder="http://192.168.1.20:8800"
          variant="solo-filled"
          spellcheck="false"
          hide-details="auto"
        />
        <v-text-field
          v-model="token"
          :label="$t('externalSource.token')"
          :hint="$t('externalSource.tokenHint')"
          persistent-hint
          :placeholder="
            source?.has_token ? $t('externalSource.tokenKept') : $t('externalSource.tokenNone')
          "
          type="password"
          autocomplete="off"
          variant="solo-filled"
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
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="editing" variant="text" color="error" :disabled="busy" @click="remove">
          {{ $t('externalSource.remove') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t(probe && !probe.ok ? 'common.close' : 'common.cancel') }}
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          rounded="pill"
          prepend-icon="mdi-check"
          :loading="busy"
          :disabled="busy || !canSave"
          @click="save"
        >
          {{ $t('externalSource.save') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  DEFAULT_EXTERNAL_SOURCE_ICON,
  EXTERNAL_SOURCE_ICONS,
  addExternalSource,
  changeExternalSource,
  removeExternalSource,
  type ExternalSource,
  type ExternalSourceProbe,
} from '@/services/connect/externalSource'
import { connectErrorMessage } from '@/services/connect/errorMessage'
import { useExternalSourceStore } from '@/stores/externalSource'

/** Adding an external source, or changing or removing one (`source`).
 * Closes on a save the app answered; stays open with the reason when it
 * did not, so the address can be fixed right there - saved either way. */
export default {
  name: 'ExternalSourceDialog',
  props: {
    modelValue: { type: Boolean, required: true },
    source: { type: Object as PropType<ExternalSource | null>, default: null },
  },
  emits: ['update:modelValue', 'saved'],
  data() {
    return {
      /** The source being changed; set by a first save of a new one, so a
       * second save changes it instead of adding another. */
      sourceId: null as string | null,
      name: '',
      icon: DEFAULT_EXTERNAL_SOURCE_ICON as string,
      baseUrl: '',
      /** Empty keeps the stored one; the stored token is never sent back. */
      token: '',
      busy: false,
      probe: null as ExternalSourceProbe | null,
      icons: EXTERNAL_SOURCE_ICONS,
    }
  },
  computed: {
    editing(): boolean {
      return this.sourceId !== null
    },
    canSave(): boolean {
      return !!this.name.trim() && !!this.baseUrl.trim()
    },
  },
  watch: {
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        if (open) this.fill(this.source)
      },
    },
  },
  methods: {
    fill(source: ExternalSource | null) {
      this.sourceId = source?.id ?? null
      this.name = source?.name ?? ''
      this.icon = source?.icon ?? DEFAULT_EXTERNAL_SOURCE_ICON
      this.baseUrl = source?.base_url ?? ''
      this.token = ''
    },
    async save() {
      this.busy = true
      const settings = {
        name: this.name,
        icon: this.icon,
        base_url: this.baseUrl,
        ...(this.token ? { token: this.token } : {}),
      }
      try {
        const { source, probe, ...sources } = this.sourceId
          ? await changeExternalSource(this.sourceId, settings)
          : await addExternalSource(settings)
        useExternalSourceStore().set(sources)
        this.$emit('saved', source, probe)
        this.probe = probe
        this.sourceId = source.id
        this.token = ''
        if (probe.ok) this.$emit('update:modelValue', false)
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
    },
    async remove() {
      if (!this.sourceId) return
      this.busy = true
      try {
        useExternalSourceStore().set(await removeExternalSource(this.sourceId))
        this.$emit('update:modelValue', false)
      } catch (error) {
        this.toastError(error)
      } finally {
        this.busy = false
      }
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
.external-source-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.external-source-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.external-source-dialog__label {
  margin: 0 0 6px;
}

.external-source-dialog__icons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
