<template>
  <!-- The recommendations behind an info button, for a setting whose two
   - dropdowns are perfectly clear about what they offer and say nothing
   - about which line to pick.
   -
   - A v-tooltip rather than a hint paragraph under the control: this is
   - five lines of advice that stop being interesting the moment somebody
   - has chosen, and a permanent block of it pushes the rest of the page
   - down for everyone who already knows. The `title` attribute would be
   - the other way to do it, and it is not one: it never appears on touch,
   - it cannot be read by keyboard, and it collapses the lines into one.
   -
   - `open-on-click` on top of the default hover, because half of this app
   - runs on a phone, where there is no hover to open anything with. -->
  <v-tooltip
    location="bottom"
    max-width="380"
    open-on-click
    :aria-label="$t('settings.qualityTipsTitle')"
  >
    <template #activator="{ props }">
      <!-- A button, not a bare icon: it is the one thing here somebody has
       - to be able to reach with the keyboard, and Vuetify's own focus and
       - ripple come with it. -->
      <v-btn
        v-bind="props"
        class="quality-tips__button"
        icon="mdi-information-outline"
        variant="text"
        density="comfortable"
        size="small"
        :aria-label="$t('settings.qualityTipsTitle')"
      />
    </template>
    <div class="quality-tips">
      <p class="quality-tips__title">{{ $t('settings.qualityTipsTitle') }}</p>
      <p v-for="line in lines" :key="line" class="quality-tips__line">{{ line }}</p>
    </div>
  </v-tooltip>
</template>

<script lang="ts">
export default {
  name: 'QualityTips',
  props: {
    /** The advice, one line each — written by the caller, since which
     * lines apply differs between local playback and casting. */
    lines: {
      type: Array as () => string[],
      required: true,
    },
  },
}
</script>

<style scoped>
/* Sized down to sit inside a label's own line rather than setting the
 * height of the row it shares. Vuetify's `small` icon button is built for
 * a toolbar, where it stands on its own. */
.quality-tips__button {
  width: 24px;
  height: 24px;
  opacity: 0.7;
}

.quality-tips__button:hover,
.quality-tips__button:focus-visible {
  opacity: 1;
}

/* Left-aligned and set as paragraphs: a tooltip's default centring reads
 * fine for the two words it is normally used for and turns five sentences
 * into a ragged block nobody can scan. */
.quality-tips {
  text-align: left;
  padding: 2px 0;
}

.quality-tips__title {
  font-weight: 600;
  margin-bottom: 6px;
}

.quality-tips__line + .quality-tips__line {
  margin-top: 5px;
}
</style>
