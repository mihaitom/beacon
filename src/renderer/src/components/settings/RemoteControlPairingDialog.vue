<template>
  <v-dialog :model-value="modelValue" max-width="420" @update:model-value="onClose">
    <v-card>
      <v-card-title>{{ $t('remoteControl.pairTitle') }}</v-card-title>
      <v-card-text>
        <!-- What Remote Control actually does — used to sit in Settings
         - next to its own enable switch (before that moved to PlayerBar.vue's
         - toolbar, see RemoteControlButton.vue), the only explanation of the
         - feature anywhere in the app now that it's gone from there. Shown
         - unconditionally (not just the non-regenerate branch below) since
         - it explains the feature itself, not the current pairing code. -->
        <p class="text-body-medium text-medium-emphasis pairing-intro">
          {{ $t('remoteControl.hint') }}
        </p>
        <v-alert
          v-if="store.needsRegenerate"
          type="info"
          variant="tonal"
          density="compact"
          class="pairing-notice"
        >
          {{ $t('remoteControl.needsRegenerate') }}
        </v-alert>
        <template v-else>
          <div class="qr-wrap">
            <canvas ref="qrCanvas" />
          </div>
          <p class="pin-display">{{ formattedPin }}</p>
          <p class="text-body-medium text-medium-emphasis pairing-hint">
            {{ $t('remoteControl.pairHint') }}
          </p>
          <v-text-field
            :model-value="store.lanUrl"
            :label="$t('remoteControl.address')"
            readonly
            variant="solo-filled"
            density="compact"
            append-inner-icon="mdi-content-copy"
            @focus="touched = true"
            @click:append-inner="copyAddress"
          />
        </template>
      </v-card-text>
      <!-- Switching the feature off lives here rather than on the button
       - that opens this: that button has to be the way *back* to the
       - pairing code now that this dialog closes itself, and a control
       - that means "show me the code" one moment and "cut every phone
       - loose" the next is one misclick from the wrong one. Both of the
       - destructive actions sit on the left, away from Done. -->
      <v-card-actions>
        <v-btn variant="text" color="error" :loading="disabling" @click="turnOff">
          {{ $t('remoteControl.turnOff') }}
        </v-btn>
        <v-btn variant="text" :loading="regenerating" @click="regenerate">
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
      disabling: false,
      // Whether this dialog has been used for anything other than holding
      // the QR code up — see the phoneConnectedSeq watcher below, which
      // leaves it alone once it has.
      touched: false,
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
      if (open) {
        this.touched = false
        void this.$nextTick(() => this.renderQr())
      }
    },
    /** Closes itself once a phone is actually on the line - watched as a
     * *rise* in the count, since the same number arriving again is a phone
     * dropping off as another joins, and a fall is one going away.
     *
     * Not a success message, which is what this looked like it wanted at
     * first: whether the pairing worked is already obvious on the phone,
     * which is where the person is looking. The problem this solves is a
     * physical one - by the time the code has been scanned the user is
     * holding a phone, and putting it down to reach for the mouse and
     * dismiss a dialog they are done with is enough friction that it just
     * stays open instead.
     *
     * Not while the dialog is being used for something else, though. It
     * also carries the PIN, the address with its copy button and
     * "regenerate", and any of those means the person is still working in
     * here - a window that vanishes mid-action, because of something that
     * happened on another device, is exactly the kind of thing this was
     * worth thinking twice about. Untouched, it is just the QR code, and
     * the QR code has done its job.
     *
     * A phone reconnecting after a network blip fires this too, and is
     * deliberately not told apart from a fresh pairing: it can only happen
     * while this dialog is open and untouched, and closing it then is
     * still the right outcome. */
    'store.phoneCount'(count: number, before: number) {
      if (count <= before) return
      if (!this.modelValue || this.touched) return
      this.onClose(false)
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
      this.touched = true
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
    async turnOff() {
      this.disabling = true
      try {
        await this.store.disable()
        this.onClose(false)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('remoteControl.title'),
          message: this.$t('remoteControl.disableFailed'),
        })
        console.error('[remoteControl] Failed to turn remote control off:', error)
      } finally {
        this.disabling = false
      }
    },
    async copyAddress() {
      this.touched = true
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

/* An image, and cover art's 4px is the app's radius for those. */
.qr-wrap canvas {
  border-radius: 4px;
}

.pairing-hint {
  margin-bottom: 16px;
  text-align: center;
}

.pin-display {
  text-align: center;
  font-size: 1.6rem;
  font-weight: 600;
  letter-spacing: 0.25em;
  margin-bottom: 4px;
}

/* The line explaining what the pairing code is for. */
.pairing-intro {
  margin-bottom: 16px;
}

.pairing-notice {
  margin-bottom: 8px;
}
</style>
