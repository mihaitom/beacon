<template>
  <v-list density="compact" class="lyrics-candidate-list">
    <v-list-item v-if="lyricsStore.candidatesLoading" disabled>
      <v-progress-circular indeterminate size="18" width="2" />
    </v-list-item>
    <v-list-item v-else-if="!hasCandidates" disabled>
      <v-list-item-title class="text-medium-emphasis text-body-medium">
        {{ $t('lyrics.noCandidates') }}
      </v-list-item-title>
    </v-list-item>
    <template v-else>
      <template v-for="group in candidateGroups" :key="group.source">
        <v-list-subheader>{{ group.source }}</v-list-subheader>
        <v-list-item
          v-for="candidate in group.results"
          :key="candidate.id"
          :active="isCurrentCandidate(group.source, candidate)"
          active-color="primary"
          class="lyrics-candidate-list__item"
          :class="{
            'lyrics-candidate-list__item--current': isCurrentCandidate(group.source, candidate),
          }"
          @click="onSelectCandidate(group.source, candidate)"
        >
          <template #prepend>
            <v-icon :icon="syncIcon(candidate)" size="x-small" :title="syncLabel(candidate)" />
          </template>
          <v-list-item-title>{{ candidate.name }}</v-list-item-title>
          <v-list-item-subtitle>{{ candidate.artist }}</v-list-item-subtitle>
          <template #append>
            <div class="lyrics-candidate-list__meta">
              <v-icon
                v-if="isCurrentCandidate(group.source, candidate)"
                icon="mdi-check-circle"
                size="x-small"
                color="primary"
                :title="$t('lyrics.currentMatch')"
              />
              <!-- A duration far off the actual song's own length is a
               - strong "wrong edit" signal (radio cut vs. album version,
               - live take, ...) — flagged in red so it's visible without
               - doing the subtraction by eye. -->
              <span
                v-if="candidate.duration != null"
                class="lyrics-candidate-list__duration"
                :class="{
                  'lyrics-candidate-list__duration--mismatch': isDurationMismatch(candidate),
                }"
              >
                {{ formatDuration(candidate.duration) }}
              </span>
              <span class="lyrics-candidate-list__score">{{ matchPercent(candidate) }}%</span>
            </div>
          </template>
        </v-list-item>
      </template>
    </template>
  </v-list>
</template>

<script lang="ts">
// LyricsCandidateList.vue — the actual "pick a different match" list,
// shared between LyricsPanel.vue's desktop v-menu and mobile v-bottom-sheet
// presentations (see that component's own comment on why two containers
// need this) — same content either way, just different chrome around it.
import { usePlaybackStore } from '@/stores/playback'
import { useLyricsStore } from '@/stores/lyrics'
import type { LyricSearchResult } from '@/services/connect/types'

// A candidate whose duration is off by more than this is almost certainly
// a different edit of the song (radio cut, live take, ...) rather than a
// timing quirk — flagged in the list, see isDurationMismatch() below.
const DURATION_MISMATCH_THRESHOLD_S = 5

export default {
  name: 'LyricsCandidateList',
  computed: {
    playbackStore() {
      return usePlaybackStore()
    },
    lyricsStore() {
      return useLyricsStore()
    },
    currentSong() {
      return this.playbackStore.currentSong
    },
    // Grouped as an array (not the raw Record from the store) so the
    // template can v-for it directly and empty-result sources don't need
    // filtering out inline.
    candidateGroups() {
      const candidates = this.lyricsStore.candidates
      if (!candidates) return []
      return Object.entries(candidates)
        .map(([source, results]) => ({ source, results }))
        .filter((group) => group.results.length > 0)
    },
    hasCandidates() {
      return this.candidateGroups.length > 0
    },
  },
  methods: {
    onSelectCandidate(source: string, candidate: LyricSearchResult) {
      if (this.currentSong) {
        void this.lyricsStore.selectCandidate(this.currentSong, source, candidate.id)
      }
    },
    // `score` is a distance (0 = identical, larger = worse — see
    // connect/routes/lyrics.py's own MATCH_THRESHOLD comparison), not
    // already a percentage. Clamped since /search, unlike /auto, doesn't
    // discard bad matches, so a candidate can score well past 1.
    matchPercent(candidate: LyricSearchResult): number {
      return Math.round(Math.max(0, Math.min(1, 1 - candidate.score)) * 100)
    },
    formatDuration(seconds: number): string {
      const total = Math.round(seconds)
      const minutes = Math.floor(total / 60)
      const secs = total % 60
      return `${minutes}:${String(secs).padStart(2, '0')}`
    },
    isDurationMismatch(candidate: LyricSearchResult): boolean {
      const songDuration = this.currentSong?.duration
      if (candidate.duration == null || songDuration == null) return false
      return Math.abs(candidate.duration - songDuration) > DURATION_MISMATCH_THRESHOLD_S
    },
    // isSync is a real tri-state, not a boolean — NetEase's search API
    // gives no signal either way (see connect/lyrics/netease.py), which is
    // a different thing to tell the user than "confirmed plain text".
    syncIcon(candidate: LyricSearchResult): string {
      if (candidate.isSync == null) return 'mdi-help-circle-outline'
      return candidate.isSync ? 'mdi-timer-sync-outline' : 'mdi-text-long'
    },
    syncLabel(candidate: LyricSearchResult): string {
      if (candidate.isSync == null) return this.$t('lyrics.syncUnknown')
      return candidate.isSync ? this.$t('lyrics.synced') : this.$t('lyrics.unsynced')
    },
    isCurrentCandidate(source: string, candidate: LyricSearchResult): boolean {
      return this.lyricsStore.source === source && this.lyricsStore.remoteId === candidate.id
    },
  },
}
</script>

<style scoped>
.lyrics-candidate-list {
  min-width: 260px;
  max-height: 320px;
  overflow-y: auto;
}

/* Vuetify's own :active tint is subtle enough to miss in a dense list —
 * the checkmark (see template) plus a bolder title makes "this is what's
 * currently loaded" unambiguous at a glance. */
.lyrics-candidate-list__item--current :deep(.v-list-item-title) {
  font-weight: 600;
}

.lyrics-candidate-list__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.lyrics-candidate-list__score,
.lyrics-candidate-list__duration {
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.45);
  margin-left: 1em;
}

.lyrics-candidate-list__duration--mismatch {
  color: rgb(var(--v-theme-error));
}
</style>
