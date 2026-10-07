<template>
  <v-dialog :model-value="modelValue" max-width="640" scrollable @update:model-value="close">
    <v-card class="beacon-dialog">
      <v-card-title>{{ $t('party.probe.title') }}</v-card-title>
      <v-card-text>
        <p class="text-body-medium text-medium-emphasis">{{ $t('party.probe.about') }}</p>
        <p class="text-body-small text-medium-emphasis party-probe__note">
          {{ $t('party.probe.dnsNote') }}
        </p>

        <div v-if="running && !result" class="party-probe__running">
          <v-progress-circular indeterminate color="primary" size="24" width="3" />
          <span class="text-body-medium">{{ $t('party.probe.running') }}</span>
        </div>
        <p v-if="failed" class="text-body-small party-probe__error">{{ $t('party.failed') }}</p>

        <template v-if="result">
          <div class="beacon-panel beacon-panel--flush party-probe__steps">
            <div v-for="step in shownSteps" :key="step.id" class="party-probe__step">
              <v-icon :icon="icons[step.status]" :color="colors[step.status]" size="20" />
              <div class="party-probe__text">
                <div class="text-body-medium">{{ $t(`party.probe.steps.${step.id}`) }}</div>
                <div class="text-body-small text-medium-emphasis">{{ explain(step) }}</div>
              </div>
            </div>
          </div>
          <!-- The usual reason guests outside cannot get in while it works at
           - home - said wherever that could be it, not as a test of its own. -->
          <p v-if="dnsSuspect" class="text-body-small party-probe__hint">
            {{ $t('party.probe.dnsHint') }}
          </p>
          <p class="text-body-small text-medium-emphasis party-probe__hint">
            {{ $t('party.probe.phoneHint') }}
            <a href="#" @click.prevent="openSetups">{{ $t('party.probe.setups') }}</a>
          </p>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :loading="running" @click="run">
          {{ $t('party.probe.again') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="close(false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import {
  probeParty,
  type ProbeResult,
  type ProbeStatus,
  type ProbeStep,
} from '@/services/party/http'

/** "Test setup" for the online party: whether a guest from outside can
 * reach the party under the address it was started from, as far as the
 * Beacon server can tell from inside (connect/core/party_probe.py). Runs as
 * soon as it is opened. */
export default {
  name: 'PartyProbeDialog',
  props: {
    modelValue: { type: Boolean, default: false },
    /** Where the party's link points: scheme, host and port. */
    origin: { type: String, required: true },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      running: false,
      failed: false,
      result: null as ProbeResult | null,
      icons: {
        ok: 'mdi-check-circle',
        warn: 'mdi-alert',
        fail: 'mdi-close-circle',
        unclear: 'mdi-help-circle',
        skipped: 'mdi-minus-circle-outline',
      } as Record<ProbeStatus, string>,
      colors: {
        ok: 'success',
        warn: 'warning',
        fail: 'error',
        unclear: 'warning',
        skipped: undefined,
      } as Record<ProbeStatus, string | undefined>,
    }
  },
  computed: {
    shownSteps(): ProbeStep[] {
      return (this.result?.steps ?? []).filter((step) => step.status !== 'skipped')
    },
    /** A name only the local network knows is the likeliest reason guests
     * outside get nowhere: it fails to resolve, resolves to an address of
     * this network, or the party could not be reached at all. */
    dnsSuspect(): boolean {
      // Where public DNS could be asked, it says so outright.
      const publicDns = this.shownSteps.find((step) => step.id === 'public-dns')
      if (publicDns && publicDns.status !== 'unclear') return publicDns.status === 'fail'
      return this.shownSteps.some(
        (step) =>
          (step.id === 'dns' && (step.status === 'fail' || step.code === 'private')) ||
          (step.id === 'reach' && (step.status === 'fail' || step.status === 'unclear')),
      )
    },
  },
  watch: {
    modelValue(open: boolean) {
      if (open) void this.run()
    },
    origin() {
      this.result = null
    },
  },
  methods: {
    async run() {
      this.running = true
      this.failed = false
      try {
        this.result = await probeParty(this.origin)
      } catch (error) {
        this.failed = true
        console.error('[party] Setup test failed:', error)
      } finally {
        this.running = false
      }
    },
    explain(step: ProbeStep): string {
      const host = new URL(this.origin).hostname
      const values = {
        host,
        addresses: this.result?.addresses.join(', ') ?? '',
        publicAddresses: this.result?.public_addresses.join(', ') ?? '',
        proxy: step.detail,
      }
      // The way in from the internet fails for the same reasons, in the
      // same words, as the way in from here.
      const id = step.id === 'reach-public' && step.code ? 'reach' : step.id
      const key = step.code ? `${id}.${step.code}` : `${id}.ok`
      return this.$t(`party.probe.codes.${key}`, values)
    },
    close(value: boolean) {
      this.$emit('update:modelValue', value)
    },
    openSetups() {
      this.$emitter.emit('openHelp', { page: 'party-mode', anchor: 'over-the-internet' })
    },
  },
}
</script>

<style scoped>
.party-probe__note {
  margin-top: 4px;
}

.party-probe__running {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.party-probe__error {
  margin-top: 12px;
  color: rgb(var(--v-theme-error));
}

.party-probe__steps {
  margin-top: 16px;
}

.party-probe__step {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
}

/* Between siblings only (docs/styleguide.md, "Dividers"). */
.party-probe__step + .party-probe__step {
  border-top: 1px solid var(--beacon-hairline);
}

.party-probe__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.party-probe__hint {
  margin-top: 12px;
}

/* The app's link colour, as in rendered markdown (base.css). */
.party-probe__hint a {
  color: rgb(var(--v-theme-primary));
}
</style>
