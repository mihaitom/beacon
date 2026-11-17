<template>
  <div
    class="fader"
    :class="{
      'fader--master': master,
      'fader--adjustable': adjustable,
      'fader--plain': plain,
      'fader--dragging': dragging,
    }"
    :style="{ '--fader-level': shownLevel }"
    :role="adjustable ? 'slider' : undefined"
    :tabindex="adjustable ? 0 : undefined"
    :aria-label="adjustable ? label : undefined"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="adjustable ? (modelValue ?? undefined) : undefined"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @keydown="onKeyDown"
    @wheel="onWheel"
  >
    <!-- A speaker's row that is its own volume slider: the fill is the level,
     - and dragging across the row sets it. Two lines (a name, a slider under
     - it) per speaker made the cast menu grow fast with several playing. -->
    <span v-if="!plain" class="fader__fill" />
    <span class="fader__icon">
      <slot name="icon" />
    </span>
    <span class="fader__label text-body-medium">{{ label }}</span>
    <span v-if="!plain" class="fader__value text-body-small">{{ valueLabel }}</span>
    <button
      v-if="removeLabel"
      type="button"
      class="fader__remove"
      :title="removeLabel"
      :aria-label="removeLabel"
      @pointerdown.stop
      @click.stop="$emit('remove')"
    >
      <v-icon icon="mdi-close" size="18" />
    </button>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { volumeAfterWheel } from '@/services/volumeWheel'

/** How far a finger has to travel sideways before the row takes the
 * gesture. Below it a touch is a tap or the start of a scroll, and neither
 * should set a volume. */
const TOUCH_SLOP_PX = 6
const KEY_STEP = 5

export default {
  name: 'VolumeFader',
  props: {
    /** 0-100, null while the device has not answered yet. */
    modelValue: {
      type: Number as PropType<number | null>,
      default: null,
    },
    label: {
      type: String,
      required: true,
    },
    adjustable: {
      type: Boolean,
      default: true,
    },
    /** A name and nothing else - the level is set elsewhere. */
    plain: {
      type: Boolean,
      default: false,
    },
    /** The row standing for several speakers: one size up. */
    master: {
      type: Boolean,
      default: false,
    },
    /** The quietest speaker's level, for a master over speakers that are
     * not all at the same level - shown as the spread in its value. */
    floor: {
      type: Number as PropType<number | null>,
      default: null,
    },
    /** Shows a remove button with this as its label. */
    removeLabel: {
      type: String,
      default: '',
    },
  },
  emits: ['update:modelValue', 'start', 'end', 'remove'],
  data() {
    return {
      dragging: false,
      pointer: null as null | { id: number; type: string; startX: number; taken: boolean },
      wheelCarry: 0,
    }
  },
  computed: {
    shownLevel(): number {
      return this.modelValue ?? 0
    },
    showSpread(): boolean {
      return (
        !this.plain && this.floor != null && this.modelValue != null && this.floor < this.modelValue
      )
    },
    valueLabel(): string {
      if (this.modelValue == null) return '–'
      return this.showSpread ? `${this.floor}–${this.modelValue}%` : `${this.modelValue}%`
    },
    canAdjust(): boolean {
      return this.adjustable && !this.plain && this.modelValue != null
    },
  },
  methods: {
    levelAt(clientX: number): number {
      const rect = (this.$el as HTMLElement).getBoundingClientRect()
      const fraction = (clientX - rect.left) / Math.max(1, rect.width)
      return Math.round(Math.min(1, Math.max(0, fraction)) * 100)
    },
    take() {
      if (this.dragging) return
      this.dragging = true
      this.$emit('start')
    },
    release() {
      if (!this.dragging) return
      this.dragging = false
      this.$emit('end')
    },
    onPointerDown(event: PointerEvent) {
      if (!this.canAdjust || event.button !== 0) return
      this.pointer = {
        id: event.pointerId,
        type: event.pointerType,
        startX: event.clientX,
        taken: false,
      }
      ;(this.$el as HTMLElement).setPointerCapture?.(event.pointerId)
      // A mouse means it from the first press; a finger only once it moves
      // sideways (see TOUCH_SLOP_PX).
      if (event.pointerType === 'mouse') {
        this.pointer.taken = true
        this.take()
        this.$emit('update:modelValue', this.levelAt(event.clientX))
      }
    },
    onPointerMove(event: PointerEvent) {
      const pointer = this.pointer
      if (!pointer || pointer.id !== event.pointerId) return
      if (!pointer.taken) {
        if (Math.abs(event.clientX - pointer.startX) < TOUCH_SLOP_PX) return
        pointer.taken = true
        this.take()
      }
      this.$emit('update:modelValue', this.levelAt(event.clientX))
    },
    onPointerUp(event: PointerEvent) {
      if (!this.pointer || this.pointer.id !== event.pointerId) return
      this.pointer = null
      this.release()
    },
    // The browser took the gesture over (a vertical scroll): whatever was
    // set so far stands.
    onPointerCancel() {
      this.pointer = null
      this.release()
    },
    onKeyDown(event: KeyboardEvent) {
      if (!this.canAdjust || this.modelValue == null) return
      const steps: Record<string, number> = {
        ArrowRight: KEY_STEP,
        ArrowUp: KEY_STEP,
        ArrowLeft: -KEY_STEP,
        ArrowDown: -KEY_STEP,
        PageUp: KEY_STEP * 2,
        PageDown: -KEY_STEP * 2,
      }
      let next: number | null = null
      if (event.key in steps) next = this.modelValue + steps[event.key]!
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = 100
      if (next == null) return
      event.preventDefault()
      this.$emit('update:modelValue', Math.min(100, Math.max(0, next)))
    },
    onWheel(event: WheelEvent) {
      if (!this.canAdjust || this.modelValue == null) return
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      // The list scrolls, and would otherwise move the row out from under
      // the pointer.
      event.preventDefault()
      const { volume, carry } = volumeAfterWheel(event, this.modelValue, 100, this.wheelCarry)
      this.wheelCarry = carry
      if (volume != null) this.$emit('update:modelValue', Math.round(volume))
    },
  },
}
</script>

<style scoped>
.fader {
  --fader-level: 0;
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  padding: 0 10px 0 12px;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.025);
  overflow: hidden;
  user-select: none;
  /* Vertical swipes still scroll the list; sideways ones are the row's. */
  touch-action: pan-y;
}

.fader--adjustable {
  cursor: ew-resize;
}

.fader--adjustable:hover {
  background: rgba(var(--v-theme-on-surface), 0.045);
}

.fader:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}

.fader > :not(.fader__fill) {
  position: relative;
}

.fader__fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: calc(var(--fader-level) * 1%);
  background: linear-gradient(
    90deg,
    rgba(var(--v-theme-primary), 0.07),
    rgba(var(--v-theme-primary), 0.2)
  );
  pointer-events: none;
  transition: width 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* Following the pointer, not gliding after it. */
.fader--dragging .fader__fill {
  transition: none;
}

/* The level's edge, lit like a meter's needle - the one place the menu
 * glows besides its title icon. */
.fader__fill::after {
  content: '';
  position: absolute;
  right: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 1px;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 10px 1px rgba(var(--v-theme-primary), 0.7);
}

.fader__icon {
  display: flex;
  color: rgb(var(--v-theme-primary));
}

.fader__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 500;
}

.fader__value {
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: rgba(var(--v-theme-on-surface), 0.75);
}

.fader__remove {
  appearance: none;
  border: 0;
  background: none;
  display: flex;
  padding: 4px;
  border-radius: 6px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.fader:hover .fader__remove,
.fader:focus-within .fader__remove,
.fader__remove:focus-visible {
  opacity: 1;
}

.fader__remove:hover {
  color: rgb(var(--v-theme-on-surface));
  background: rgba(var(--v-theme-on-surface), 0.08);
}

@media (hover: none) {
  .fader__remove {
    opacity: 1;
  }
}

.fader--master {
  height: 54px;
  background: rgba(var(--v-theme-primary), 0.05);
}

.fader--master .fader__fill {
  background: linear-gradient(
    90deg,
    rgba(var(--v-theme-primary), 0.12),
    rgba(var(--v-theme-primary), 0.3)
  );
}

.fader--master .fader__label {
  font-weight: 600;
}

.fader--master .fader__value {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .fader__fill {
    transition: none;
  }
}
</style>
