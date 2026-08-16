<template>
  <transition-group name="toast-fade" tag="div" class="toast-stack">
    <div
      v-for="(toast, index) in toasts"
      :key="toast.id"
      class="toast"
      :class="[toast.level, { clickable: toast.clickable }]"
      :style="{ zIndex: 9999 + index }"
      @click="handleToastClick(toast)"
    >
      <div class="toast-icon">
        <v-icon size="16">{{ getIcon(toast.level) }}</v-icon>
      </div>
      <div class="toast-body">
        <div class="toast-title">{{ toast.title }}</div>
        <div class="toast-message">{{ toast.message }}</div>
      </div>
      <button class="toast-close" @click.stop="removeToast(toast.id)">
        <v-icon size="14">mdi-close</v-icon>
      </button>
    </div>
  </transition-group>
</template>

<script lang="ts">
import { emitter } from '@/emitter'
import type { ToastTuple } from '@/types/events'
import type Toast from '@/types/toast'
import { defineComponent } from 'vue'

type ToastInternal = Toast & { id: number; visible: boolean }

export default defineComponent({
  name: 'ToastSnackbar',
  data() {
    return {
      toasts: [] as ToastInternal[],
      nextId: 1,
      maxToasts: 3,
    }
  },
  methods: {
    normalizeToast(payload: Toast | ToastTuple): Toast {
      if (Array.isArray(payload)) {
        const [level, title, message] = payload
        return { level, title, message }
      }
      return payload
    },
    getIcon(level: Toast['level']) {
      switch (level) {
        case 'error':
          return 'mdi-alert'
        case 'information':
          return 'mdi-information'
        case 'success':
          return 'mdi-checkbox-marked-circle'
        default:
          return 'mdi-information'
      }
    },
    addToast(toast: Toast) {
      if (this.toasts.length >= this.maxToasts) {
        this.toasts.shift()
      }
      const id = this.nextId++
      const newToast: ToastInternal = {
        ...toast,
        id,
        visible: true,
      }
      this.toasts.push(newToast)

      this.logEvent(toast)
      // Auto-dismiss
      setTimeout(() => {
        this.removeToast(id)
      }, 12000)
    },
    removeToast(id: number) {
      const toast = this.toasts.find((t) => t.id === id)
      if (toast) {
        toast.visible = false
        this.toasts = this.toasts.filter((t) => t.id !== id)
      }
    },
    handleToastClick(toast: ToastInternal) {
      if (toast.clickable && toast.onClick) {
        toast.onClick()
        this.removeToast(toast.id)
      }
    },
    logEvent(toast: Toast) {
      if (toast.level === 'error') {
        console.error(`${toast.title} - ${toast.message}`)
      } else {
        console.info(`${toast.title} - ${toast.message}`)
      }
    },
  },
  created() {
    emitter.on('toast', (payload) => {
      this.addToast(this.normalizeToast(payload))
    })
  },
})
</script>

<style scoped>
/* Fixed to the viewport, centered above the transport bar — same "float
 * above PlayerBar" convention as TrackList.vue's .selection-bar (88px
 * PlayerBar height + 16px gap = 104px), and the same z-index that
 * comment references back to this file, so the two never fight for
 * stacking order if they're ever both on screen. */
.toast-stack {
  position: fixed;
  width: min(360px, calc(100vw - 32px));
  bottom: 104px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  z-index: 9999;
}

.toast {
  position: relative;
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

/* Same "lit edge" language as .section-title/.beacon-rail's active
 * indicator elsewhere in the app — a thin glowing bar in the level's own
 * color reads as this app's version of a colored toast, instead of the
 * generic filled-gradient-card Material pattern. */
.toast::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--toast-accent);
  box-shadow: 0 0 8px 1px color-mix(in srgb, var(--toast-accent) 60%, transparent);
}

.toast.information {
  --toast-accent: rgb(var(--v-theme-info));
}

.toast.success {
  --toast-accent: rgb(var(--v-theme-success));
}

.toast.error {
  --toast-accent: rgb(var(--v-theme-error));
}

.toast.clickable {
  cursor: pointer;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.toast.clickable:hover {
  transform: translateY(-2px);
  box-shadow:
    inset 0 0 0 1px var(--toast-accent),
    0 16px 32px rgba(0, 0, 0, 0.45);
}

.toast-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-top: 1px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--toast-accent) 16%, #1a1d27);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--toast-accent) 30%, transparent);
  color: var(--toast-accent);
}

.toast-body {
  flex: 1 1 auto;
  min-width: 0;
  padding-top: 1px;
}

.toast-title {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
  color: rgb(var(--v-theme-on-surface));
}

.toast-message {
  margin-top: 2px;
  font-size: 0.8rem;
  line-height: 1.45;
  word-break: break-word;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.toast-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -2px -2px -2px 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 55%, transparent);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.toast-close:hover {
  background: var(--beacon-hover);
  color: rgb(var(--v-theme-on-surface));
}

.toast-fade-move,
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s cubic-bezier(0.2, 0.8, 0.4, 1);
}

.toast-fade-enter-from {
  opacity: 0;
  transform: translateY(16px) scale(0.98);
}

.toast-fade-leave-active {
  position: absolute;
  width: 100%;
}

.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}
</style>
