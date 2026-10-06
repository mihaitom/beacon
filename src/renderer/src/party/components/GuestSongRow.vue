<template>
  <!-- The phone list primitive (.mobile-row, base.css), on desktop too:
   - the guest page's lists are the same short lists either way. -->
  <div class="mobile-row guest-row" :class="{ 'guest-row--tappable': tappable }">
    <div class="mobile-row__art guest-row__art">
      <img v-if="cover && !broken" :src="cover" alt="" loading="lazy" @error="broken = true" />
      <v-icon v-else :icon="fallbackIcon" size="22" class="text-medium-emphasis" />
    </div>
    <div class="mobile-row__text">
      <div class="text-body-medium">{{ title }}</div>
      <div class="text-body-small text-medium-emphasis">
        {{ subtitle }}
        <span v-if="note" class="guest-row__note">· {{ note }}</span>
      </div>
    </div>
    <slot name="action" />
  </div>
</template>

<script lang="ts">
export default {
  name: 'GuestSongRow',
  props: {
    title: { type: String, required: true },
    subtitle: { type: String, default: '' },
    cover: { type: String as () => string | null, default: null },
    /** Who wished for it, or "your wish" - amber, after the artist. */
    note: { type: String as () => string | null, default: null },
    fallbackIcon: { type: String, default: 'mdi-album' },
    tappable: { type: Boolean, default: false },
  },
  data() {
    return { broken: false }
  },
  watch: {
    cover() {
      this.broken = false
    },
  },
}
</script>

<style scoped>
/* 48px, MOBILE_ROW_ART_SIZE - the size every phone row uses. */
.guest-row__art {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
}

.guest-row__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.guest-row__note {
  color: rgb(var(--v-theme-primary));
}

.guest-row--tappable {
  cursor: pointer;
}

.guest-row--tappable:hover {
  background: var(--beacon-hover);
}
</style>
