<template>
  <section class="mood-mixes">
    <h2 class="section-title">{{ $t('home.moodsTitle') }}</h2>
    <div class="mood-mixes__grid">
      <button
        v-for="mood in moods"
        :key="mood"
        type="button"
        class="mood-tile"
        :class="`mood-tile--${mood}`"
        :disabled="loading !== null && loading !== mood"
        :aria-busy="loading === mood"
        @click="$emit('play', mood)"
      >
        <v-icon class="mood-tile__icon" :icon="ICONS[mood]" size="40" />
        <span class="mood-tile__label">{{ $t(`home.moods.${mood}`) }}</span>
        <v-progress-circular
          v-if="loading === mood"
          class="mood-tile__spinner"
          indeterminate
          size="20"
          width="2"
        />
        <v-icon v-else class="mood-tile__play" icon="mdi-play" size="20" />
      </button>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { Mood } from '@/composables/sonicHomeShelves'

const ICONS: Record<Mood, string> = {
  happy: 'mdi-white-balance-sunny',
  relaxed: 'mdi-leaf',
  party: 'mdi-party-popper',
  danceable: 'mdi-music-note-eighth',
  sad: 'mdi-weather-rainy',
  aggressive: 'mdi-lightning-bolt',
}

/** One tile per AudioMuse-AI mood; each plays a mix in that mood. */
export default {
  name: 'MoodMixes',
  props: {
    moods: { type: Array as PropType<Mood[]>, required: true },
    /** The mood whose mix is on its way, or null. */
    loading: { type: String as PropType<Mood | null>, default: null },
  },
  emits: ['play'],
  data() {
    return { ICONS }
  },
}
</script>

<style scoped>
/* Space around it is the page's: the desktop and the phone set their
 * shelves apart differently. */
.mood-mixes .section-title {
  margin-bottom: 16px;
}

.mood-mixes__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

/* Each mood keeps a hue of its own on every theme - the one exception to
 * "no colour in a component" (see docs/styleguide.md, Palette): it names
 * the mood, it is not interface. Only as a tint over the surface, so the
 * label stays the theme's own text colour. */
.mood-tile--happy {
  --mood: 242, 190, 60;
}
.mood-tile--relaxed {
  --mood: 72, 178, 160;
}
.mood-tile--party {
  --mood: 214, 88, 168;
}
.mood-tile--danceable {
  --mood: 138, 108, 228;
}
.mood-tile--sad {
  --mood: 88, 130, 205;
}
.mood-tile--aggressive {
  --mood: 226, 74, 70;
}

.mood-tile {
  position: relative;
  display: flex;
  align-items: flex-end;
  min-height: 84px;
  padding: 14px 16px;
  overflow: hidden;
  border: 1px solid rgba(var(--mood), 0.32);
  border-radius: 14px;
  background:
    radial-gradient(circle at 100% 0%, rgba(var(--mood), 0.42), transparent 62%),
    linear-gradient(135deg, rgba(var(--mood), 0.2), rgba(var(--mood), 0.06));
  color: rgb(var(--v-theme-on-surface));
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    opacity 0.15s ease;
}

.mood-tile:hover:not(:disabled) {
  transform: translateY(-2px);
  border-color: rgba(var(--mood), 0.6);
}

.mood-tile:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.mood-tile:disabled {
  cursor: default;
  opacity: 0.5;
}

.mood-tile__icon {
  position: absolute;
  top: 10px;
  right: 12px;
  color: rgb(var(--mood));
  opacity: 0.9;
}

.mood-tile__label {
  font-size: 1rem;
  font-weight: 600;
}

.mood-tile__play,
.mood-tile__spinner {
  position: absolute;
  right: 14px;
  bottom: 14px;
  color: rgb(var(--v-theme-on-surface));
}

.mood-tile__play {
  opacity: 0;
  transition: opacity 0.15s ease;
}

.mood-tile:hover .mood-tile__play,
.mood-tile:focus-visible .mood-tile__play {
  opacity: 0.8;
}

@media (prefers-reduced-motion: reduce) {
  .mood-tile {
    transition: none;
  }
  .mood-tile:hover:not(:disabled) {
    transform: none;
  }
}
</style>
