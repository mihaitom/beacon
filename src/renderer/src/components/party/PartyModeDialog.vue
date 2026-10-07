<template>
  <v-dialog :model-value="modelValue" max-width="900" scrollable @update:model-value="onClose">
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

        <!-- A phone that is not casting keeps the party alive only while
         - it is awake - said plainly before the party is started. -->
        <p v-if="isPhone && !store.serverHosted" class="text-body-small party-phone-warning">
          {{ $t('party.runsLocallyPhone') }}
        </p>

        <!-- Which path answers guests: connect while casting, else this
         - window (see docs/plans/party-mode-server-side.md). -->
        <v-alert
          v-if="hostedHere"
          :type="store.serverHosted ? 'success' : 'warning'"
          variant="tonal"
          density="compact"
          class="party-notice"
        >
          {{ store.serverHosted ? $t('party.runsOnServer') : $t('party.runsLocally') }}
        </v-alert>
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

        <!-- Side by side while the party runs here - the invitation, the
         - rules, and who came - so a party of a normal size fits without
         - scrolling. The columns fold underneath each other on a narrow
         - screen. -->
        <div class="party-columns" :class="{ 'party-columns--running': hostedHere }">
          <section v-if="hostedHere && store.inviteUrl" class="party-column">
            <h3 class="eyebrow-label panel-title">{{ $t('party.invitation') }}</h3>
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
          </section>

          <section class="party-column party-column--rules">
            <h3 class="eyebrow-label panel-title">{{ $t('party.rules') }}</h3>
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
              <v-select
                v-if="store.onlineAvailable"
                :model-value="store.settings.listenKbps"
                :items="listenOptions"
                :label="$t('party.listen')"
                :hint="$t('party.listenHint')"
                persistent-hint
                variant="solo-filled"
                class="party-settings__online"
                @update:model-value="(v: number) => store.saveSettings({ listenKbps: v })"
              />
            </div>
          </section>

          <section v-if="hostedHere" class="party-column">
            <h3 class="eyebrow-label panel-title">
              {{ $t('party.guests', { count: store.guests.length }) }}
            </h3>
            <p
              v-if="store.listenKbps && store.listeners"
              class="text-body-small text-medium-emphasis party-listeners"
            >
              {{ $t('party.listeners', { count: store.listeners, mbps: uploadMbps }) }}
            </p>
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
          </section>
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
import { isMobileWebNow } from '@/composables/useIsMobileWeb'

const LIMITS = [1, 2, 3, 5, 10]
// What connect's listen-along stream offers (core/party_broadcast.py's
// BITRATES_KBPS).
const LISTEN_BITRATES = [128, 192, 256]
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
      isPhone: false,
      linkCopiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  computed: {
    store() {
      return usePartyStore()
    },
    /** Running, and answered by this window: the invitation and the guest
     * list are this window's to show. */
    hostedHere(): boolean {
      return this.store.enabled && this.store.hostedHere
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
    listenOptions() {
      return [
        { title: this.$t('party.listenOff'), value: 0 },
        ...LISTEN_BITRATES.map((kbps) => ({
          title: this.$t('party.listenAac', { kbps }),
          value: kbps,
        })),
      ]
    },
    uploadMbps(): string {
      const mbps = (this.store.listeners * this.store.listenKbps) / 1000
      return mbps.toLocaleString(this.$i18n.locale, { maximumFractionDigits: 1 })
    },
    durationOptions() {
      return DURATIONS.map((h) => ({ title: this.$t('party.hours', { count: h }), value: h }))
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (!open) return
      this.isPhone = isMobileWebNow()
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
      void this.drawQr(this.$refs.qrCanvas as HTMLCanvasElement | undefined, 200)
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

.party-phone-warning {
  color: rgb(var(--v-theme-warning));
  margin: -8px 0 16px;
}

.party-notice {
  margin-bottom: 16px;
}

/* Columns of at least 240px, as many as fit: three while the party runs
 * in a 900px dialog (invitation, rules, guests), one under the other on a
 * phone. Before it starts there are only the rules, which then spread over
 * the whole width instead (see .party-settings). */
.party-columns {
  display: grid;
  gap: 16px 28px;
}

.party-columns--running {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.party-column {
  min-width: 0;
}

.party-column .panel-title {
  margin-bottom: 12px;
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

.party-listeners {
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

/* One column of fields in the running layout's narrow third; side by side
 * before the party starts, when the rules have the dialog to themselves. */
.party-settings {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

/* The online party's field carries a line of explanation under it; across
 * the whole row so that line has room. */
.party-settings__online {
  grid-column: 1 / -1;
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
