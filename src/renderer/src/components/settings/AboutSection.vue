<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.about') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <div class="about-actions">
          <v-btn variant="tonal" prepend-icon="mdi-star-circle-outline" @click="showReleaseNotes">
            {{ $t('settings.whatsNew') }}
          </v-btn>
          <!-- Sits with the other two rather than in a section of its own:
             - it answers the same kind of question they do — what is this
             - version, what can it do, who does it talk to — and a
             - one-button section would read as more ceremony than the
             - dialog behind it warrants. -->
          <v-btn variant="tonal" prepend-icon="mdi-shield-lock-outline" @click="privacyOpen = true">
            {{ $t('privacy.title') }}
          </v-btn>
          <!-- The "?" key opens the same dialog, but nothing on screen says
           - so — this is where someone who has never pressed it finds out
           - the shortcuts exist at all. Which is also why it is not
           - offered on the phone layout: there is no keyboard to press
           - any of them with, and a list of key combinations is the one
           - thing a touch device can do nothing at all with. -->
          <v-btn
            v-if="!isMobileWeb"
            variant="tonal"
            prepend-icon="mdi-keyboard-outline"
            @click="showShortcuts"
          >
            {{ $t('shortcuts.title') }}
          </v-btn>
        </div>
      </div>

      <div class="setting">
        <div class="status-row">
          <span class="status-dot" :class="ffmpegFound ? 'status-dot--ok' : 'status-dot--warn'" />
          <span class="setting__hint setting__hint--inline">
            {{ ffmpegFound ? $t('settings.ffmpegFound') : $t('settings.ffmpegMissing') }}
          </span>
        </div>
        <p class="setting__hint">{{ $t('settings.version', { version: appVersion }) }}</p>
        <v-alert
          v-if="updateStore.available"
          type="info"
          variant="tonal"
          density="compact"
          class="settings-progress"
        >
          {{ $t('settings.updateAvailable', { version: updateStore.latestVersion }) }}
          <a
            v-if="updateStore.releaseUrl"
            :href="updateStore.releaseUrl"
            target="_blank"
            rel="noopener"
            class="update-link"
          >
            {{ $t('settings.updateAvailableLink') }}
          </a>
        </v-alert>
      </div>
    </div>
  </section>

  <privacy-dialog v-model="privacyOpen" />
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useIsMobileWeb } from '@/composables/useIsMobileWeb'
import { useUpdateStore } from '@/stores/update'
import packageJson from '../../../../../package.json'
import PrivacyDialog from './PrivacyDialog.vue'

/**
 * What this copy of Beacon is: version, whether an update is waiting,
 * whether the backend found ffmpeg, and the two sheets that explain the
 * app itself (shortcuts, privacy).
 */
export default {
  name: 'AboutSection',
  components: { PrivacyDialog },
  // Composition API escape hatch just for useIsMobileWeb() - everything
  // else stays Options API, same idiom as App.vue's identical use of it.
  setup() {
    return { isMobileWeb: useIsMobileWeb() }
  },
  data() {
    return {
      appVersion: packageJson.version,
      privacyOpen: false,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    updateStore() {
      return useUpdateStore()
    },
    ffmpegFound(): boolean {
      return this.authStore.health?.ffmpeg ?? true
    },
  },
  methods: {
    showShortcuts() {
      this.$emitter.emit('toggleKeyboardShortcuts')
    },
    showReleaseNotes() {
      this.$emitter.emit('openReleaseNotes')
    },
  },
}
</script>

<style scoped>
.about-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.update-link {
  margin-left: 0.4em;
  font-weight: 600;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
