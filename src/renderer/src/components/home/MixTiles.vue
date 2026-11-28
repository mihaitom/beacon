<template>
  <section class="mood-mixes">
    <h2 class="section-title">{{ title }}</h2>
    <div class="mood-mixes__grid" :style="{ '--mood-count': items.length }">
      <button
        v-for="item in items"
        :key="item"
        type="button"
        class="mood-tile"
        :class="[
          `mood-tile--${kind}-${item}`,
          {
            'mood-tile--loading': loading === key(item),
            'mood-tile--playing': playing === key(item),
            'mood-tile--paused': playing === key(item) && paused,
          },
        ]"
        :disabled="loading !== null && loading !== key(item)"
        :aria-busy="loading === key(item)"
        :aria-current="playing === key(item) ? 'true' : undefined"
        @click="$emit('play', item)"
      >
        <span class="mood-tile__glow" aria-hidden="true" />
        <v-icon class="mood-tile__art" :icon="ICONS[key(item)]" aria-hidden="true" />
        <span class="mood-tile__label">{{ $t(`home.${kind}s.${item}`) }}</span>
        <span v-if="playing === key(item)" class="mood-tile__bars" aria-hidden="true">
          <i /><i /><i />
        </span>
        <span v-else class="mood-tile__play" aria-hidden="true">
          <v-icon icon="mdi-play" size="18" />
        </span>
      </button>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { homeMixKey, type HomeMixKind } from '@/composables/sonicHomeShelves'

const ICONS: Record<string, string> = {
  'mood:happy': 'mdi-white-balance-sunny',
  'mood:relaxed': 'mdi-leaf',
  'mood:party': 'mdi-party-popper',
  'mood:danceable': 'mdi-music-note-eighth',
  'mood:sad': 'mdi-weather-rainy',
  'mood:aggressive': 'mdi-lightning-bolt',
  'theme:onTheRoad': 'mdi-road-variant',
  'theme:city': 'mdi-city-variant-outline',
  'theme:nature': 'mdi-pine-tree',
  'theme:inLove': 'mdi-heart',
  'theme:heartbreak': 'mdi-heart-broken',
  'theme:lookingBack': 'mdi-history',
}

/** One tile per AudioMuse-AI mood or lyric theme; each plays a mix of it.
 * `loading` and `playing` are keys across both rows (see homeMixKey()), so
 * a mix on its way in one row holds the other row too. */
export default {
  name: 'MixTiles',
  props: {
    kind: { type: String as PropType<HomeMixKind>, required: true },
    title: { type: String, required: true },
    items: { type: Array as PropType<string[]>, required: true },
    /** The mix on its way, or null. */
    loading: { type: String as PropType<string | null>, default: null },
    /** The mix that plays now, or null. */
    playing: { type: String as PropType<string | null>, default: null },
    /** Whether playback is paused, so the playing tile holds still. */
    paused: { type: Boolean, default: false },
  },
  emits: ['play'],
  data() {
    return { ICONS }
  },
  methods: {
    key(item: string): string {
      return homeMixKey(this.kind, item)
    },
  },
}
</script>

<style scoped>
/* Space around it is the page's: the desktop and the phone set their
 * shelves apart differently. */
.mood-mixes .section-title {
  margin-bottom: 16px;
}

/* Whole rows across the full width: all moods side by side where they
 * fit, otherwise three or two to a row - never a lone tile left over, and
 * no empty columns on the right. Measured on the section, not the window,
 * since the nav rail and queue drawer take part of it. */
.mood-mixes {
  container-type: inline-size;
}

.mood-mixes__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

@container (min-width: 520px) {
  .mood-mixes__grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@container (min-width: 900px) {
  .mood-mixes__grid {
    grid-template-columns: repeat(var(--mood-count), 1fr);
  }
}

/* Each mood and theme keeps two hues of its own on every theme - the exception to
 * "no colour in a component" (see docs/styleguide.md, Palette): they name
 * the mood, they are not interface. The label stays the theme's text
 * colour, so it reads on light and dark themes alike. */
.mood-tile--mood-happy {
  --mood: 247, 186, 52;
  --mood-2: 245, 112, 84;
}
.mood-tile--mood-relaxed {
  --mood: 64, 184, 160;
  --mood-2: 72, 140, 210;
}
.mood-tile--mood-party {
  --mood: 222, 76, 170;
  --mood-2: 250, 150, 60;
}
.mood-tile--mood-danceable {
  --mood: 140, 100, 236;
  --mood-2: 60, 196, 230;
}
.mood-tile--mood-sad {
  --mood: 84, 128, 214;
  --mood-2: 110, 84, 190;
}
.mood-tile--mood-aggressive {
  --mood: 232, 66, 64;
  --mood-2: 250, 128, 40;
}
.mood-tile--theme-onTheRoad {
  --mood: 238, 142, 58;
  --mood-2: 214, 84, 70;
}
.mood-tile--theme-city {
  --mood: 98, 108, 234;
  --mood-2: 206, 76, 206;
}
.mood-tile--theme-nature {
  --mood: 70, 168, 92;
  --mood-2: 156, 192, 64;
}
.mood-tile--theme-inLove {
  --mood: 236, 78, 122;
  --mood-2: 250, 150, 172;
}
.mood-tile--theme-heartbreak {
  --mood: 150, 88, 176;
  --mood-2: 86, 108, 196;
}
.mood-tile--theme-lookingBack {
  --mood: 200, 152, 88;
  --mood-2: 150, 118, 204;
}

.mood-tile {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: flex-end;
  min-height: 112px;
  padding: 16px 18px;
  overflow: hidden;
  border: 1px solid rgba(var(--mood), 0.3);
  border-radius: 18px;
  background:
    radial-gradient(120% 90% at 100% 0%, rgba(var(--mood), 0.5), transparent 60%),
    radial-gradient(110% 100% at 0% 100%, rgba(var(--mood-2), 0.34), transparent 65%),
    linear-gradient(150deg, rgba(var(--mood), 0.14), rgba(var(--mood-2), 0.1));
  background-color: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1),
    box-shadow 0.25s ease,
    border-color 0.25s ease,
    opacity 0.2s ease;
}

/* A soft light that follows the hover in from the top: the tile lights up
 * rather than only moving. */
.mood-tile__glow {
  position: absolute;
  inset: 0;
  z-index: -1;
  background: radial-gradient(80% 70% at 70% 0%, rgba(var(--mood), 0.45), transparent 70%);
  opacity: 0;
  transition: opacity 0.3s ease;
}

/* The mood's symbol, large and cropped by the corner, as the tile's art. */
.mood-tile__art {
  position: absolute;
  right: -14px;
  bottom: -18px;
  z-index: -1;
  font-size: 96px;
  color: rgb(var(--mood));
  opacity: 0.32;
  transform: rotate(-14deg);
  transition:
    transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.3s ease;
}

.mood-tile__label {
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.mood-tile__play,
.mood-tile__bars {
  position: absolute;
  top: 14px;
  left: 16px;
}

.mood-tile__play {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  /* The dark pill a button on a cover gets: white on a yellow tint would
   * not read. */
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  color: #fff;
  opacity: 0;
  transform: scale(0.7);
  transition:
    opacity 0.2s ease,
    transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.mood-tile:hover:not(:disabled),
.mood-tile:focus-visible {
  transform: translateY(-3px);
  border-color: rgba(var(--mood), 0.65);
  box-shadow: 0 12px 28px -12px rgba(var(--mood), 0.7);
}

.mood-tile:hover:not(:disabled) .mood-tile__glow,
.mood-tile:focus-visible .mood-tile__glow,
.mood-tile--playing .mood-tile__glow {
  opacity: 1;
}

.mood-tile:hover:not(:disabled) .mood-tile__art,
.mood-tile:focus-visible .mood-tile__art {
  opacity: 0.5;
  transform: rotate(0deg) scale(1.08);
}

.mood-tile:hover:not(:disabled) .mood-tile__play,
.mood-tile:focus-visible .mood-tile__play {
  opacity: 1;
  transform: scale(1);
}

.mood-tile:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.mood-tile:disabled {
  cursor: default;
  opacity: 0.45;
}

/* Loading: a sheen sweeping across while the mix is put together. */
.mood-tile--loading::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 30%,
    rgba(var(--v-theme-on-surface), 0.16) 50%,
    transparent 70%
  );
  transform: translateX(-100%);
  animation: mood-sheen 1.1s ease-in-out infinite;
}

@keyframes mood-sheen {
  to {
    transform: translateX(100%);
  }
}

/* Playing: the tile stays lit and its bars move with the music - and hold
 * still while it is paused. */
.mood-tile--playing {
  border-color: rgba(var(--mood), 0.8);
  box-shadow:
    0 0 0 1px rgba(var(--mood), 0.4),
    0 12px 32px -14px rgba(var(--mood), 0.8);
}

.mood-tile__bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 18px;
}

.mood-tile__bars i {
  width: 4px;
  height: 100%;
  border-radius: 2px;
  background: rgb(var(--mood));
  transform-origin: bottom;
  animation: mood-bar 0.9s ease-in-out infinite alternate;
}

.mood-tile__bars i:nth-child(2) {
  animation-delay: -0.3s;
  animation-duration: 0.7s;
}

.mood-tile__bars i:nth-child(3) {
  animation-delay: -0.6s;
  animation-duration: 1.1s;
}

.mood-tile--paused .mood-tile__bars i {
  animation-play-state: paused;
}

@keyframes mood-bar {
  from {
    transform: scaleY(0.25);
  }
  to {
    transform: scaleY(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mood-tile,
  .mood-tile__art,
  .mood-tile__play {
    transition: none;
  }
  .mood-tile:hover:not(:disabled),
  .mood-tile:focus-visible {
    transform: none;
  }
  .mood-tile--loading::after,
  .mood-tile__bars i {
    animation: none;
  }
}
</style>
