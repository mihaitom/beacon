<template>
  <v-dialog :model-value="modelValue" max-width="420" @update:model-value="onClose">
    <v-card>
      <v-card-title>{{ $t('remoteControl.pairTitle') }}</v-card-title>
      <v-card-text>
        <v-alert v-if="store.needsRegenerate" type="info" variant="tonal" density="compact" class="mb-2">
          {{ $t('remoteControl.needsRegenerate') }}
        </v-alert>
        <template v-else>
          <div class="qr-wrap">
            <canvas ref="qrCanvas" />
          </div>
          <p class="pin-display text-center">{{ formattedPin }}</p>
          <p class="text-body-2 text-medium-emphasis text-center mb-4">
            {{ $t('remoteControl.pairHint') }}
          </p>
          <v-text-field
            :model-value="store.lanUrl"
            :label="$t('remoteControl.address')"
            readonly
            variant="solo-filled"
            density="compact"
            append-inner-icon="mdi-content-copy"
            @click:append-inner="copyAddress"
          />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn variant="text" color="error" :loading="regenerating" @click="regenerate">
          {{ $t('remoteControl.regenerate') }}
        </v-btn>
        <v-spacer />
        <v-btn color="primary" @click="onClose(false)">{{ $t('common.done') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import QRCode from 'qrcode'
import { useRemoteControlStore } from '@/stores/remoteControl'

export default {
  name: 'RemoteControlPairingDialog',
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      regenerating: false,
    }
  },
  computed: {
    store() {
      return useRemoteControlStore()
    },
    formattedPin(): string {
      const pin = this.store.pin ?? ''
      return pin ? `${pin.slice(0, 3)} ${pin.slice(3)}` : ''
    },
    // The QR encodes address + password together so scanning skips the PIN
    // screen entirely (see connect/static/remote/app.js's consumePairingLink()) —
    // the PIN itself stays the fallback for typing it in by hand.
    pairUrl(): string {
      return `${this.store.lanUrl}#/pair?password=${encodeURIComponent(this.store.password ?? '')}`
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (open) void this.$nextTick(() => this.renderQr())
    },
  },
  methods: {
    async renderQr() {
      if (this.store.needsRegenerate || !this.store.password) return
      const canvas = this.$refs.qrCanvas as HTMLCanvasElement | undefined
      if (!canvas) return
      try {
        await QRCode.toCanvas(canvas, this.pairUrl, { width: 220, margin: 1 })
      } catch (error) {
        console.error('[remoteControl] Failed to render QR code:', error)
      }
    },
    async regenerate() {
      this.regenerating = true
      try {
        await this.store.enable()
        await this.$nextTick()
        void this.renderQr()
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('remoteControl.pairTitle'),
          message: this.$t('remoteControl.enableFailed'),
        })
        console.error('[remoteControl] Failed to regenerate pairing code:', error)
      } finally {
        this.regenerating = false
      }
    },
    async copyAddress() {
      try {
        await navigator.clipboard.writeText(this.store.lanUrl)
      } catch (error) {
        console.error('[remoteControl] Failed to copy address:', error)
      }
    },
    onClose(value: boolean) {
      this.$emit('update:modelValue', value)
    },
  },
}
</script>

<style scoped>
.qr-wrap {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}

.qr-wrap canvas {
  border-radius: 8px;
}

.pin-display {
  font-size: 1.6rem;
  font-weight: 600;
  letter-spacing: 0.25em;
  margin-bottom: 4px;
}
</style>
