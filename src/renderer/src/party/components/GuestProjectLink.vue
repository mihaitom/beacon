<template>
  <a
    :href="url"
    target="_blank"
    rel="noopener noreferrer"
    class="text-body-small guest-project-link"
    :class="{ 'guest-project-link--compact': compact }"
    :title="$t('partyGuest.project')"
  >
    <v-icon icon="mdi-github" size="14" />
    <span>Beacon</span>
  </a>
</template>

<script lang="ts">
import { GITHUB_URL } from '@/services/project'

/** Where Beacon comes from, kept quiet in the top-left corner of whatever
 * guest screen it sits on. The parent has to be positioned. */
export default {
  name: 'GuestProjectLink',
  props: {
    /** A phone: closer to the corner, as Now Playing's own toolbar is. */
    compact: { type: Boolean, default: false },
  },
  data() {
    return { url: GITHUB_URL }
  },
}
</script>

<style scoped>
/* Opposite the Now Playing toolbar, on the same translucent pill so it
 * reads over a photo. */
.guest-project-link {
  position: absolute;
  top: 24px;
  left: 24px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(18, 20, 28, 0.55);
  backdrop-filter: blur(8px);
  color: inherit;
  text-decoration: none;
  opacity: 0.55;
  transition: opacity 0.15s;
}

.guest-project-link:hover,
.guest-project-link:focus-visible {
  opacity: 1;
}

.guest-project-link.guest-project-link--compact {
  top: 8px;
  left: 8px;
}
</style>
