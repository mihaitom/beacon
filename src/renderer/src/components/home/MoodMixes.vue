<template>
  <section class="mood-mixes">
    <h2 class="section-title">{{ $t('home.moodsTitle') }}</h2>
    <div class="mood-mixes__row">
      <v-btn
        v-for="mood in moods"
        :key="mood"
        variant="tonal"
        rounded="pill"
        :prepend-icon="ICONS[mood]"
        :loading="loading === mood"
        :disabled="loading !== null && loading !== mood"
        @click="$emit('play', mood)"
      >
        {{ $t(`home.moods.${mood}`) }}
      </v-btn>
    </div>
  </section>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type { Mood } from '@/composables/sonicHomeShelves'

const ICONS: Record<Mood, string> = {
  happy: 'mdi-emoticon-happy-outline',
  relaxed: 'mdi-sofa-outline',
  party: 'mdi-party-popper',
  danceable: 'mdi-human-female-dance',
  sad: 'mdi-weather-rainy',
  aggressive: 'mdi-lightning-bolt-outline',
}

/** One button per AudioMuse-AI mood; each plays a mix in that mood. */
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

.mood-mixes__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
