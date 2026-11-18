<template>
  <v-dialog :model-value="modelValue" max-width="420" @update:model-value="onClose">
    <v-card class="airplay-pairing">
      <v-card-title class="airplay-pairing__title">
        {{ $t('connect.pairDeviceTitle', { name: deviceName }) }}
      </v-card-title>
      <v-card-text class="airplay-pairing__body">
        <!-- Finding the device takes a scan of up to ten seconds - long enough
         - that a bare spinner reads as a hang. -->
        <div v-if="loading && !started" class="airplay-pairing__waiting">
          <v-progress-circular indeterminate color="primary" size="24" width="3" />
          <span class="text-body-medium">
            {{ $t('connect.pairConnecting', { name: deviceName }) }}
          </span>
        </div>
        <v-alert v-if="error" type="error" variant="tonal" density="compact">
          {{ error }}
        </v-alert>
        <template v-if="started && !error">
          <template v-if="devicePin">
            <p class="text-body-medium text-medium-emphasis">
              {{ $t('connect.pairPinPrompt') }}
            </p>
            <!-- Text, not a number field, and no fixed length: a device may show
             - four digits or six, an AirPort Express takes a code its owner
             - chose, and a number would lose a leading zero. -->
            <v-text-field
              v-model="pin"
              :label="$t('connect.pin')"
              inputmode="numeric"
              autocomplete="one-time-code"
              variant="solo-filled"
              hide-details
              autofocus
              :disabled="loading"
              class="airplay-pairing__pin"
              @keyup.enter="finish"
            />
          </template>
          <p v-else class="text-body-medium text-medium-emphasis">
            {{ $t('connect.pairConfirmPrompt') }}
          </p>
        </template>
      </v-card-text>
      <v-card-actions class="airplay-pairing__actions">
        <v-spacer />
        <v-btn variant="text" @click="onClose(false)">{{ $t('common.cancel') }}</v-btn>
        <!-- A failed attempt ends the session on connect's side (a wrong PIN
         - included), so the way on is a fresh start, not another "Done". -->
        <v-btn
          v-if="error"
          color="primary"
          variant="flat"
          rounded="pill"
          prepend-icon="mdi-refresh"
          @click="start"
        >
          {{ $t('common.retry') }}
        </v-btn>
        <v-btn
          v-else
          color="primary"
          variant="flat"
          rounded="pill"
          :disabled="!canFinish"
          :loading="loading && started"
          @click="finish"
        >
          {{ $t('common.done') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { useConnectStore } from '@/stores/connect'

export default {
  name: 'AirplayPairingDialog',
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    deviceName: {
      type: String,
      default: '',
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      started: false,
      devicePin: false,
      pin: '',
      loading: false,
      error: null as string | null,
    }
  },
  computed: {
    connectStore() {
      return useConnectStore()
    },
    canFinish(): boolean {
      if (!this.started || this.loading) return false
      return !this.devicePin || this.pin.length > 0
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (open) this.start()
      else this.reset()
    },
    // Through the model rather than on input: a letter typed after digits
    // leaves the filtered value unchanged and would otherwise stay on screen.
    pin(value: string | null) {
      const digits = (value ?? '').replace(/\D/g, '')
      if (digits !== value) this.pin = digits
    },
  },
  methods: {
    async start() {
      this.reset()
      this.loading = true
      try {
        const result = await this.connectStore.startPairing(this.deviceName)
        this.devicePin = result.device_provides_pin
        this.started = true
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },
    async finish() {
      if (!this.canFinish) return
      this.loading = true
      this.error = null
      try {
        await this.connectStore.finishPairing(
          this.deviceName,
          this.devicePin ? this.pin : undefined,
        )
        this.onClose(false)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },
    reset() {
      this.started = false
      this.devicePin = false
      this.pin = ''
      this.error = null
    },
    onClose(value: boolean) {
      this.$emit('update:modelValue', value)
    },
  },
}
</script>

<style scoped>
.airplay-pairing.v-card {
  border-radius: 16px;
}

/* A device name can be long; the title wraps rather than ellipsising it. */
.airplay-pairing__title {
  padding-top: 20px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.airplay-pairing__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 12px;
}

.airplay-pairing__waiting {
  display: flex;
  align-items: center;
  gap: 12px;
}

.airplay-pairing__actions {
  padding: 8px 24px 20px;
}
</style>
