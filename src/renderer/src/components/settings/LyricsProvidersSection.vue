<template>
  <!-- An opt-out: see stores/lyricsProviders.ts on why every provider is
   - selected by default. Empty is still a valid, deliberate state (fully
   - opted out), not an error, so the hint below explains what it means
   - rather than the select complaining about it. -->
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.lyricsProvidersTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.lyricsProvidersHint') }}</p>
        <v-select
          :model-value="lyricsProvidersStore.enabled"
          :items="lyricProviders"
          :label="$t('settings.lyricsProviders')"
          variant="solo-filled"
          multiple
          chips
          closable-chips
          hide-details
          @update:model-value="lyricsProvidersStore.setEnabled($event)"
        />
        <p class="setting__hint">
          {{
            lyricsProvidersStore.enabled.length === 0
              ? $t('settings.lyricsProvidersEmptyHint')
              : $t('settings.lyricsProvidersActiveHint')
          }}
        </p>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useLyricsProvidersStore, LYRIC_PROVIDERS } from '@/stores/lyricsProviders'

/**
 * Which third-party lyrics services a song's title and artist may be sent
 * to. An opt-out: every provider is on until somebody takes one away, and
 * an empty selection is a deliberate state rather than an error.
 */
export default {
  name: 'LyricsProvidersSection',
  computed: {
    lyricsProvidersStore() {
      return useLyricsProvidersStore()
    },
    lyricProviders() {
      return LYRIC_PROVIDERS
    },
  },
}
</script>
