<template>
  <transition name="update-toast-fade">
    <div v-if="updateStore.shouldNotify" class="update-toast">
      <div class="update-toast-icon">
        <v-icon size="16">mdi-arrow-up-bold-circle</v-icon>
      </div>
      <div class="update-toast-body">
        <div class="update-toast-title">
          {{ $t('updateToast.title', { version: updateStore.latestVersion }) }}
        </div>
        <div class="update-toast-message">{{ message }}</div>
        <div class="update-toast-actions">
          <a
            v-if="updateStore.releaseUrl"
            :href="updateStore.releaseUrl"
            target="_blank"
            rel="noopener"
            class="update-toast-action"
          >
            {{ $t('settings.updateAvailableLink') }}
          </a>
          <button class="update-toast-action" @click="onSnooze">
            {{ $t('updateToast.remindLater') }}
          </button>
        </div>
      </div>
      <button class="update-toast-close" :title="$t('common.close')" @click="onDismiss">
        <v-icon size="14">mdi-close</v-icon>
      </button>
    </div>
  </transition>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useUpdateStore } from '@/stores/update'

export default defineComponent({
  name: 'UpdateToast',
  computed: {
    updateStore() {
      return useUpdateStore()
    },
    // Electron's own checkForUpdates() (src/main/index.ts) already downloads
    // in the background and installs on next quit via
    // autoUpdater.autoInstallOnAppQuit — nothing for the user to do there.
    // The web/Docker build has no such mechanism at all (see
    // services/updateCheck.ts's own comment); "available" is the most this
    // toast can honestly say for it.
    message(): string {
      return window.api
        ? this.$t('updateToast.electronMessage', { version: this.updateStore.latestVersion })
        : this.$t('updateToast.webMessage', { version: this.updateStore.latestVersion })
    },
  },
  methods: {
    onDismiss() {
      this.updateStore.dismiss()
    },
    onSnooze() {
      this.updateStore.snooze()
    },
  },
})
</script>

<style scoped>
/* Own fixed position (not toast.vue's shared stack) — that one auto-dismisses
 * every entry after 12s (see its own addToast()), which would silently
 * throw away an update notice nobody had a chance to read or act on yet.
 * Top-right rather than toast.vue's bottom-center specifically so an
 * action-feedback toast (e.g. "Cache cleared") showing at the same time
 * never overlaps this one — the two are visually distinct categories
 * (transient confirmation vs. a persistent, dismissable notice) anyway. */
.update-toast {
  position: fixed;
  width: min(360px, calc(100vw - 32px));
  top: 16px;
  right: 16px;
  z-index: 9998;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem 0.75rem 0.75rem 1rem;
  border-radius: 12px;
  background: #1a1d27;
  box-shadow:
    inset 0 0 0 1px var(--beacon-hairline),
    0 12px 28px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(10px);
}

.update-toast::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: rgb(var(--v-theme-info));
  box-shadow: 0 0 8px 1px color-mix(in srgb, rgb(var(--v-theme-info)) 60%, transparent);
}

.update-toast-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-top: 1px;
  border-radius: 8px;
  background: color-mix(in srgb, rgb(var(--v-theme-info)) 16%, #1a1d27);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-info)) 30%, transparent);
  color: rgb(var(--v-theme-info));
}

.update-toast-body {
  flex: 1 1 auto;
  min-width: 0;
  padding-top: 1px;
}

.update-toast-title {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
  color: rgb(var(--v-theme-on-surface));
}

.update-toast-message {
  margin-top: 2px;
  font-size: 0.8rem;
  line-height: 1.45;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.update-toast-actions {
  display: flex;
  gap: 1rem;
  margin-top: 0.5rem;
}

.update-toast-action {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
  cursor: pointer;
}

.update-toast-action:hover {
  text-decoration: underline;
}

.update-toast-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -2px -2px -2px 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 55%, transparent);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.update-toast-close:hover {
  background: var(--beacon-hover);
  color: rgb(var(--v-theme-on-surface));
}

.update-toast-fade-enter-active,
.update-toast-fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s cubic-bezier(0.2, 0.8, 0.4, 1);
}

.update-toast-fade-enter-from,
.update-toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-12px) scale(0.98);
}
</style>
