<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.appearanceTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <v-select
          :model-value="appearance.theme"
          :items="themeItems"
          :label="$t('settings.theme')"
          variant="solo-filled"
          hide-details
          @update:model-value="appearance.setTheme($event)"
        >
          <template #selection="{ item }">
            <span class="theme-option">
              <theme-swatch :colors="swatchOf(item.value!)" />
              {{ item.title }}
            </span>
          </template>
          <template #item="{ item, props: itemProps }">
            <v-list-item v-bind="itemProps" :subtitle="item.subtitle">
              <template #prepend>
                <theme-swatch class="theme-option__swatch" :colors="swatchOf(item.value!)" />
              </template>
            </v-list-item>
          </template>
          <template #subheader="{ props: headerProps }">
            <v-list-subheader>{{ headerProps.title }}</v-list-subheader>
          </template>
        </v-select>
        <p class="setting__hint">{{ $t('settings.themeHint') }}</p>
      </div>

      <div class="setting">
        <v-switch
          :model-value="appearance.adaptiveAccent"
          color="primary"
          density="compact"
          hide-details
          :label="$t('settings.adaptiveAccent')"
          @update:model-value="appearance.setAdaptiveAccent(!!$event)"
        />
        <p class="setting__hint">{{ $t('settings.adaptiveAccentHint') }}</p>
      </div>

      <!-- Only the two colours a theme is recognisable by: everything else
         - (the surfaces, the frame, whether text is light or dark) follows
         - from the background, the way the presets' own steps do. -->
      <div v-if="appearance.theme === 'custom'" class="setting">
        <p class="setting__label">{{ $t('settings.customTheme') }}</p>
        <div class="custom-colors">
          <v-menu
            v-for="field in colorFields"
            :key="field.key"
            :close-on-content-click="false"
            location="bottom start"
          >
            <template #activator="{ props: menuProps }">
              <v-btn v-bind="menuProps" variant="tonal" class="custom-color">
                <span
                  class="custom-color__chip"
                  :style="{ background: appearance.custom[field.key] }"
                />
                <span class="custom-color__text">
                  <span>{{ field.label }}</span>
                  <span class="text-medium-emphasis">{{ appearance.custom[field.key] }}</span>
                </span>
              </v-btn>
            </template>
            <v-color-picker
              :model-value="appearance.custom[field.key]"
              mode="hex"
              :modes="['hex']"
              elevation="8"
              @update:model-value="setColor(field.key, $event)"
            />
          </v-menu>
        </div>
        <p v-if="lowContrast" class="setting__hint custom-colors__warning">
          {{ $t('settings.customThemeLowContrast') }}
        </p>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useAppearanceStore } from '@/stores/appearance'
import {
  PRESET_THEMES,
  customTheme,
  type CustomThemeColors,
  type ThemeDefinitionColors,
  type ThemeId,
} from '@/plugins/theme'
import { contrast, isHexColor } from '@/services/themeColors'
import ThemeSwatch from '@/components/settings/ThemeSwatch.vue'

/** A row of the theme menu: a theme, or Vuetify's subheader/divider. */
interface ThemeItem {
  type?: 'subheader' | 'divider'
  value?: ThemeId
  title?: string
  subtitle?: string
}

// Below this an accent no longer stands out as one: WCAG's floor for large
// text and for the parts of a control that have to be seen.
const MIN_ACCENT_CONTRAST = 3

/**
 * The app's theme: four presets and one made from two colours. Applied the
 * moment it is picked (main.ts follows the store), for this device only -
 * see stores/appearance.ts.
 */
export default {
  name: 'AppearanceSection',
  components: { ThemeSwatch },
  computed: {
    appearance() {
      return useAppearanceStore()
    },
    themeItems(): ThemeItem[] {
      const preset = (id: ThemeId): ThemeItem => ({
        value: id,
        title: this.$t(`settings.themes.${id}.name`),
        subtitle: this.$t(`settings.themes.${id}.description`),
      })
      return [
        { type: 'subheader', title: this.$t('settings.themeGroupDark') },
        preset('beacon'),
        preset('graphite'),
        { type: 'subheader', title: this.$t('settings.themeGroupLight') },
        preset('paper'),
        preset('glacier'),
        { type: 'divider' },
        preset('custom'),
      ]
    },
    colorFields(): { key: keyof CustomThemeColors; label: string }[] {
      return [
        { key: 'background', label: this.$t('settings.customThemeBackground') },
        { key: 'primary', label: this.$t('settings.customThemeAccent') },
      ]
    },
    lowContrast(): boolean {
      const { background, primary } = this.appearance.custom
      return contrast(background, primary) < MIN_ACCENT_CONTRAST
    },
  },
  methods: {
    swatchOf(id: ThemeId): string[] {
      const colors: ThemeDefinitionColors =
        id === 'custom'
          ? customTheme(this.appearance.custom).colors!
          : PRESET_THEMES.find((preset) => preset.id === id)!.definition.colors!
      return [colors.background, colors.surface, colors.primary] as string[]
    },
    setColor(key: keyof CustomThemeColors, value: string): void {
      // The picker can hand back an alpha channel (#RRGGBBAA) while it is
      // being typed into; a theme colour is opaque.
      const hex = typeof value === 'string' ? value.slice(0, 7) : ''
      if (isHexColor(hex)) this.appearance.setCustomColors({ [key]: hex })
    },
  },
}
</script>

<style scoped>
.theme-option {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.theme-option__swatch {
  margin-right: 14px;
}

.custom-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.custom-color.v-btn {
  height: auto;
  padding: 8px 14px 8px 8px;
  justify-content: flex-start;
}

.custom-color__chip {
  width: 32px;
  height: 32px;
  margin-right: 10px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.2);
}

.custom-color__text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  font-variant-numeric: tabular-nums;
}

.custom-colors__warning {
  color: rgb(var(--v-theme-warning));
}
</style>
