<template>
  <v-dialog :model-value="modelValue" max-width="420" @update:model-value="onClose">
    <v-card>
      <v-card-title>{{ $t('connect.pairDeviceTitle', { name: deviceName }) }}</v-card-title>
      <v-card-text>
        <v-progress-circular v-if="loading" indeterminate class="mb-2" />
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-2">
          {{ error }}
        </v-alert>
        <template v-if="started && !error">
          <p v-if="devicePin" class="mb-2">
            {{ $t('connect.pairPinPrompt') }}
          </p>
          <v-text-field
            v-if="devicePin"
            v-model="pin"
            :label="$t('connect.pin')"
            type="number"
            variant="solo-filled"
            @keyup.enter="finish"
          />
          <p v-else class="mb-2">{{ $t('connect.pairConfirmPrompt') }}</p>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="onClose(false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :disabled="!started || loading" @click="finish">{{
          $t('common.done')
        }}</v-btn>
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
  },
  watch: {
    modelValue(open: boolean) {
      if (open) this.start()
      else this.reset()
    },
  },
  methods: {
    async start() {
      this.loading = true
      this.error = null
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
      this.loading = true
      this.error = null
      try {
        await this.connectStore.finishPairing(
          this.deviceName,
          this.devicePin ? Number(this.pin) : undefined,
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
