<template>
  <v-dialog :model-value="modelValue" max-width="460" scrollable @update:model-value="onClose">
    <v-card class="beacon-dialog">
      <v-card-title class="party-title">
        <span>{{ $t('party.title') }}</span>
        <v-btn
          icon="mdi-help-circle-outline"
          variant="text"
          density="comfortable"
          :title="$t('help.title')"
          @click="$emitter.emit('openHelp', 'party-mode')"
        />
      </v-card-title>
      <v-card-text>
        <p class="text-body-medium text-medium-emphasis party-intro">{{ $t('party.hint') }}</p>

        <!-- Running, and answered by this window: the invitation itself. -->
        <template v-if="store.enabled && store.hostedHere">
          <template v-if="store.inviteUrl">
            <div class="party-qr">
              <canvas ref="qrCanvas" />
            </div>
            <v-text-field
              :model-value="store.inviteUrl"
              :label="$t('party.link')"
              readonly
              variant="solo-filled"
              density="compact"
              :hint="linkCopied ? $t('party.copied') : undefined"
              :persistent-hint="linkCopied"
            >
              <!-- Same as the Quick Connect code's copy button: a checkmark
               - for a moment, rather than a toast for something this small. -->
              <template #append-inner>
                <v-icon
                  :icon="linkCopied ? 'mdi-check' : 'mdi-content-copy'"
                  :color="linkCopied ? 'success' : undefined"
                  :title="linkCopied ? $t('party.copied') : $t('party.copyLink')"
                  @click="copyLink"
                />
              </template>
            </v-text-field>
            <v-btn variant="tonal" block prepend-icon="mdi-fullscreen" @click="showPoster = true">
              {{ $t('party.showPoster') }}
            </v-btn>
          </template>

          <h3 class="eyebrow-label panel-title party-section">
            {{ $t('party.guests', { count: store.guests.length }) }}
          </h3>
          <p v-if="!store.guests.length" class="text-body-small text-medium-emphasis">
            {{ $t('party.noGuests') }}
          </p>
          <div v-for="guest in store.guests" :key="guest.guest_id" class="party-guest">
            <v-icon
              :icon="guest.connected ? 'mdi-circle' : 'mdi-circle-outline'"
              :color="guest.connected ? 'success' : undefined"
              size="10"
            />
            <span class="text-body-medium party-guest__name">{{ guest.name }}</span>
            <v-btn
              icon="mdi-account-remove"
              size="small"
              variant="text"
              :title="$t('party.removeGuest', { name: guest.name })"
              @click="kick(guest.guest_id)"
            />
          </div>
        </template>

        <!-- Running, but some other tab is the one answering guests. -->
        <v-alert
          v-else-if="store.enabled"
          type="info"
          variant="tonal"
          density="compact"
          class="party-notice"
        >
          {{ $t('party.hostedElsewhere') }}
        </v-alert>

        <h3 class="eyebrow-label panel-title party-section">{{ $t('party.rules') }}</h3>
        <div class="party-settings">
          <v-select
            :model-value="store.settings.maxPendingPerGuest"
            :items="limitOptions"
            :label="$t('party.limit')"
            variant="solo-filled"
            hide-details
            @update:model-value="(v: number) => store.saveSettings({ maxPendingPerGuest: v })"
          />
          <v-select
            :model-value="store.settings.skipRatio"
            :items="skipOptions"
            :label="$t('party.skip')"
            variant="solo-filled"
            hide-details
            @update:model-value="(v: number) => store.saveSettings({ skipRatio: v })"
          />
          <v-select
            v-if="!store.enabled"
            :model-value="store.settings.durationHours"
            :items="durationOptions"
            :label="$t('party.duration')"
            variant="solo-filled"
            hide-details
            @update:model-value="(v: number) => store.saveSettings({ durationHours: v })"
          />
        </div>
      </v-card-text>

      <v-card-actions>
        <template v-if="store.enabled">
          <v-btn variant="text" color="error" :loading="busy === 'end'" @click="end">
            {{ $t('party.end') }}
          </v-btn>
          <v-btn
            v-if="store.hostedHere"
            variant="text"
            :loading="busy === 'rotate'"
            @click="rotate"
          >
            {{ $t('party.renewLink') }}
          </v-btn>
          <v-btn v-else variant="text" @click="store.takeOver()">
            {{ $t('party.takeOver') }}
          </v-btn>
        </template>
        <v-spacer />
        <v-btn v-if="!store.enabled" color="primary" :loading="busy === 'start'" @click="start">
          {{ $t('party.start') }}
        </v-btn>
        <v-btn v-else color="primary" @click="onClose(false)">{{ $t('common.done') }}</v-btn>
      </v-card-actions>
    </v-card>

    <!-- The QR code on its own, large, for a screen or tablet put up where
     - the guests are. -->
    <v-dialog v-model="showPoster" fullscreen>
      <div class="party-poster" @click="showPoster = false">
        <v-icon icon="mdi-lighthouse-on" color="primary" size="48" />
        <h1 class="display-title party-poster__title">{{ $t('party.posterTitle') }}</h1>
        <canvas ref="posterCanvas" class="party-poster__qr" />
        <p class="text-body-large text-medium-emphasis">{{ $t('party.posterHint') }}</p>
      </div>
    </v-dialog>
  </v-dialog>
</template>

<script lang="ts">
import QRCode from 'qrcode'
import { usePartyStore } from '@/stores/party'

const LIMITS = [1, 2, 3, 5, 10]
const DURATIONS = [2, 4, 8, 12, 24, 48]

export default {
  name: 'PartyModeDialog',
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      busy: null as 'start' | 'end' | 'rotate' | null,
      showPoster: false,
      linkCopied: false,
      linkCopiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    store() {
      return usePartyStore()
    },
    limitOptions() {
      return LIMITS.map((n) => ({ title: String(n), value: n }))
    },
    skipOptions() {
      return [
        { title: this.$t('party.skipOff'), value: 0 },
        { title: this.$t('party.skipShare', { share: '1/3' }), value: 1 / 3 },
        { title: this.$t('party.skipShare', { share: '1/2' }), value: 0.5 },
        { title: this.$t('party.skipShare', { share: '2/3' }), value: 2 / 3 },
      ]
    },
    durationOptions() {
      return DURATIONS.map((h) => ({ title: this.$t('party.hours', { count: h }), value: h }))
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (!open) return
      void this.$nextTick(() => this.renderQr())
      // A party started from another window since this one last asked.
      void this.store.refreshStatus()
    },
    'store.inviteUrl'() {
      void this.$nextTick(() => this.renderQr())
    },
    showPoster(open: boolean) {
      if (open) void this.$nextTick(() => this.renderPoster())
    },
  },
  beforeUnmount() {
    clearTimeout(this.linkCopiedTimer)
  },
  methods: {
    async drawQr(canvas: HTMLCanvasElement | undefined, width: number) {
      const url = this.store.inviteUrl
      if (!canvas || !url) return
      try {
        await QRCode.toCanvas(canvas, url, { width, margin: 1 })
      } catch (error) {
        console.error('[party] Failed to render QR code:', error)
      }
    },
    renderQr() {
      void this.drawQr(this.$refs.qrCanvas as HTMLCanvasElement | undefined, 240)
    },
    renderPoster() {
      // Sized to the shorter side of the window, leaving room for the
      // heading above it and the line below.
      const side = Math.min(window.innerWidth, window.innerHeight) * 0.6
      void this.drawQr(this.$refs.posterCanvas as HTMLCanvasElement | undefined, side)
    },
    async run(kind: 'start' | 'end' | 'rotate', action: () => Promise<void>) {
      this.busy = kind
      try {
        await action()
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('party.title'),
          message: this.$t('party.failed'),
        })
        console.error(`[party] ${kind} failed:`, error)
      } finally {
        this.busy = null
      }
    },
    start() {
      void this.run('start', () => this.store.enable())
    },
    end() {
      void this.run('end', () => this.store.disable())
    },
    rotate() {
      void this.run('rotate', () => this.store.rotate())
    },
    async kick(guestId: string) {
      try {
        await this.store.kick(guestId)
      } catch (error) {
        console.error('[party] Failed to remove guest:', error)
      }
    },
    /** A failure is only logged, as the Quick Connect code's copy button
     * does: the link is on screen either way, and the checkmark not
     * appearing says clearly enough that nothing was copied. */
    async copyLink() {
      try {
        await navigator.clipboard.writeText(this.store.inviteUrl ?? '')
      } catch (error) {
        console.error('[party] Failed to copy link:', error)
        return
      }
      this.linkCopied = true
      clearTimeout(this.linkCopiedTimer)
      this.linkCopiedTimer = setTimeout(() => {
        this.linkCopied = false
      }, 2000)
    },
    onClose(value: boolean) {
      this.$emit('update:modelValue', value)
    },
  },
}
</script>

<style scoped>
.party-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.party-intro {
  margin-bottom: 16px;
}

.party-qr {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}

/* An image, and cover art's 4px is the app's radius for those. */
.party-qr canvas,
.party-poster__qr {
  border-radius: 4px;
}

.party-notice {
  margin-bottom: 8px;
}

.party-section {
  margin-top: 20px;
  margin-bottom: 8px;
}

.party-guest {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}

.party-guest__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.party-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.party-poster {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  height: 100%;
  padding: 24px;
  background: var(--beacon-chrome);
  cursor: pointer;
  text-align: center;
}

.party-poster__title {
  font-size: clamp(1.8rem, 4vw, 3rem);
}
</style>
