<template>
  <transition-group name="fade" tag="div" class="toast-stack">
    <div
      v-for="(toast, index) in toasts"
      :key="toast.id"
      class="toast"
      :class="[toast.level, { clickable: toast.clickable }]"
      :style="{ zIndex: 1000 + index }"
      @click="handleToastClick(toast)"
    >
      <div class="toast-icon-container">
        <v-icon class="icon" left>{{ getIcon(toast.level) }}</v-icon>
      </div>
      <div class="text-container">
        <div class="title">{{ toast.title }}</div>
        <div class="text">
          {{ toast.message }}
        </div>
      </div>
      <button class="toast-icon-container-close" @click="removeToast(toast.id)">
        <v-icon class="icon" left>mdi-close</v-icon>
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
.toast-stack {
  position: fixed;
  width: 500px;
  bottom: 16px;
  left: calc(50% - 250px);
  display: flex;
  flex-direction: column;
  gap: 1rem;
  z-index: 9999;
}

.toast {
  position: relative;
  display: flex;
  align-items: center;
  color: white;
  padding: 14px 16px;
  border-radius: 12px;
  min-width: 320px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  top: 0;
  transform: scale(1);
  border-left: 5px solid rgba(255, 255, 255, 0.35);
  backdrop-filter: blur(8px);
}

.toast.clickable {
  cursor: pointer;
  transition:
    transform 0.2s ease-in-out,
    box-shadow 0.2s ease;
}

.toast.clickable:hover {
  transform: translateY(-2px) scale(1.01);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}

.toast.information {
  background: linear-gradient(
    135deg,
    rgb(var(--v-theme-info)),
    color-mix(in srgb, rgb(var(--v-theme-info)) 80%, black)
  );
}

.toast.error {
  background: linear-gradient(
    135deg,
    rgb(var(--v-theme-error)),
    color-mix(in srgb, rgb(var(--v-theme-error)) 80%, black)
  );
}

.toast.success {
  background: linear-gradient(
    135deg,
    rgb(var(--v-theme-success)),
    color-mix(in srgb, rgb(var(--v-theme-success)) 80%, black)
  );
}

.toast-icon-container {
  display: flex;
  text-align: center;
  align-items: center;
  justify-content: center;
  font-size: 45px;
  width: 60px;
  color: white;
}

.text-container {
  display: flex;
  flex-direction: column;
  width: 350px;
  padding: 5px 15px;
  max-height: min(min-content, 200px);
}

.title {
  font-size: 20px;
  font-weight: bold;
  padding-bottom: 4px;
  color: white;
}

.text {
  font-size: 16px;
  font-weight: normal;
  width: 100%;
  word-break: break-word;
  color: white;
}

.toast-icon-container-close {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  width: 50px;
  transition: scale 0.3s ease-in-out;
  color: white;
  background-color: transparent;
  border: none;
}

.toast-icon-container-close {
  cursor: pointer;
}

.close-btn {
  background: transparent;
  border: none;
  color: white;
  cursor: pointer;
  margin-left: auto;
  background-color: transparent;
}

.fade-move,
.fade-enter-active {
  transition:
    top 0.5s cubic-bezier(0.8, -0.5, 0.4, 1.5),
    transform 0.5s cubic-bezier(0.8, -0.8, 0.4, 1.5);
}

.fade-enter-from {
  transform: translateY(120%);
}

.fade-leave-active {
  position: absolute;
  top: 0;
  transition:
    top 0.5s cubic-bezier(0.8, -0.5, 0.4, 1.5),
    transform 0.5s cubic-bezier(0.8, -0.8, 0.4, 1.5);
}

.fade-leave-to {
  transform: translateY(-120%);
  transform: scale(0.6);
}
</style>
