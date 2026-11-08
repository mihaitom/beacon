<template>
  <!-- The same head as the smart playlist editor: a stack of records and the
   - name in the title's own type. A new playlist's sleeves are empty until
   - there is something to put in them; the front one lights up with a name,
   - which is also the moment the dialog can be confirmed. -->
  <div class="playlist-dialog-head" :class="{ 'playlist-dialog-head--lit': modelValue.trim() }">
    <record-stack
      :covers="covers"
      :size="RECORD_SIZE"
      :depth="3"
      :rise="RECORD_RISE"
      :browsing="browsing"
      fallback-icon="mdi-playlist-music"
      @mouseenter="browsing = true"
      @mouseleave="browsing = false"
    />
    <div class="playlist-dialog-head__heading">
      <div class="eyebrow-label">{{ eyebrow }}</div>
      <input
        ref="field"
        :value="modelValue"
        class="detail-title playlist-dialog-head__name"
        :placeholder="$t('playlists.namePlaceholder')"
        :aria-label="$t('common.name')"
        maxlength="200"
        spellcheck="false"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @keyup.enter="$emit('confirm')"
      />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import RecordStack from './RecordStack.vue'

const RECORD_SIZE = 84
const RECORD_RISE = 7

/** What the new-playlist and edit dialogs open with: the playlist's records
 * and its name, typed straight into the title. */
export default {
  name: 'PlaylistDialogHead',
  components: { RecordStack },
  props: {
    modelValue: { type: String, required: true },
    eyebrow: { type: String, required: true },
    covers: { type: Array as PropType<string[]>, default: () => [] },
  },
  emits: ['update:modelValue', 'confirm'],
  data() {
    return { RECORD_SIZE, RECORD_RISE, browsing: false }
  },
  methods: {
    focus(): void {
      ;(this.$refs.field as HTMLInputElement | undefined)?.focus()
    },
  },
}
</script>

<style scoped>
.playlist-dialog-head {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 26px 24px 22px;
  border-bottom: 1px solid var(--beacon-hairline);
}

.playlist-dialog-head :deep(.cover-art-fallback) {
  transition: color 0.6s ease;
}

.playlist-dialog-head--lit :deep(.record-stack__record:first-child .cover-art-fallback) {
  color: rgb(var(--v-theme-primary));
}

.playlist-dialog-head__heading {
  flex: 1;
  min-width: 0;
}

/* Well over the 16px floor for anything that takes a cursor. A line rather
 * than a box, so it reads as the title it is about to be. */
.playlist-dialog-head__name.detail-title {
  width: 100%;
  margin-top: 6px;
  padding: 2px 0 6px;
  border: 0;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.18);
  outline: none;
  background: none;
  color: inherit;
  font-size: 1.6rem;
  caret-color: rgb(var(--v-theme-primary));
  transition: border-color 0.15s ease;
}

.playlist-dialog-head__name::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.38);
}

.playlist-dialog-head__name:focus {
  border-bottom-color: rgb(var(--v-theme-primary));
}

@media (prefers-reduced-motion: reduce) {
  .playlist-dialog-head :deep(.cover-art-fallback) {
    transition: none;
  }
}
</style>
