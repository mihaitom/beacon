<template>
  <v-container fluid class="smart-editor">
    <section class="smart-editor__hero">
      <!-- The preview's lead album, blurred - two layers so a change of
       - rules crossfades it (see services/crossfadeBackdrop.ts). -->
      <div
        v-for="(url, i) in backdrop.urls"
        :key="i"
        class="smart-editor__backdrop"
        :class="{ 'smart-editor__backdrop--active': i === backdrop.active }"
        :style="url ? { '--backdrop-image': `url(${url})` } : {}"
      />
      <div class="smart-editor__scrim" />
      <div class="smart-editor__hero-content">
        <playlist-cover
          :covers="previewCovers"
          :loading="!preview"
          :size="168"
          cycling
          fallback-icon="mdi-playlist-star"
          class="smart-editor__cover cover-shadow"
        />
        <div class="smart-editor__heading">
          <div class="eyebrow-label">{{ $t('smartPlaylists.eyebrow') }}</div>
          <input
            v-model="name"
            class="detail-title smart-editor__name"
            :placeholder="$t('smartPlaylists.defaultName')"
            :aria-label="$t('smartPlaylists.nameLabel')"
            :readonly="readonly"
            maxlength="200"
            spellcheck="false"
            @input="nameTouched = true"
          />
          <div class="text-body-medium text-medium-emphasis">{{ metaLine }}</div>
          <div class="smart-editor__actions">
            <v-btn
              v-if="!readonly"
              color="primary"
              rounded="pill"
              prepend-icon="mdi-content-save-outline"
              :loading="saving"
              :disabled="loading"
              @click="save"
            >
              {{ $t('smartPlaylists.save') }}
            </v-btn>
            <v-btn variant="text" rounded="pill" @click="leave">
              {{ readonly ? $t('common.close') : $t('common.cancel') }}
            </v-btn>
          </div>
        </div>
      </div>
    </section>

    <v-alert v-if="loadError" type="error" variant="tonal" class="smart-editor__notice">
      {{ loadError }}
    </v-alert>
    <v-alert v-if="readonly" type="info" variant="tonal" class="smart-editor__notice">
      {{ $t('smartPlaylists.fileWarning', { file: filePath }) }}
    </v-alert>
    <v-alert v-if="saveError" type="error" variant="tonal" class="smart-editor__notice">
      {{ saveError }}
    </v-alert>
    <v-alert v-if="problemMessage" type="warning" variant="tonal" class="smart-editor__notice">
      {{ problemMessage }}
    </v-alert>

    <div v-if="loading" class="smart-editor__loading">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <div v-else class="smart-editor__body">
      <div class="smart-editor__main">
        <section v-if="isNew && !readonly" class="smart-editor__presets">
          <h2 class="eyebrow-label panel-title">{{ $t('smartPlaylists.startFrom') }}</h2>
          <div class="smart-editor__chips">
            <v-chip
              v-for="preset in presets"
              :key="preset.id"
              :prepend-icon="preset.icon"
              variant="tonal"
              color="primary"
              @click="applyPreset(preset)"
            >
              {{ $t(`smartPlaylists.presets.${preset.id}`) }}
            </v-chip>
          </div>
        </section>

        <section class="beacon-panel smart-editor__rules">
          <div class="smart-editor__sentence">
            <span>{{ $t('smartPlaylists.matchPrefix') }}</span>
            <smart-conjunction-toggle
              :model-value="rules.conjunction"
              :readonly="readonly"
              @update:model-value="rules = { ...rules, conjunction: $event }"
            />
            <span>{{ $t('smartPlaylists.matchSuffix') }}</span>
          </div>

          <transition-group name="smart-row" tag="div" class="smart-editor__rows">
            <template v-for="(node, index) in rules.children" :key="node.key">
              <smart-rule-row
                v-if="node.type === 'rule'"
                :rule="node"
                :suggestions="suggestionsFor(node.field)"
                :playlists="playlistOptions"
                :readonly="readonly"
                :invalid="invalidKeys.includes(node.key)"
                :culprit="preview?.emptiedBy === node.key"
                @update="replaceChild(index, $event)"
                @remove="removeChild(index)"
              />
              <smart-rule-group
                v-else-if="node.type === 'group'"
                :group="node"
                :suggestions-for="suggestionsFor"
                :playlists="playlistOptions"
                :readonly="readonly"
                :invalid-keys="invalidKeys"
                :invalid="invalidKeys.includes(node.key)"
                :class="{ 'smart-editor__culprit': preview?.emptiedBy === node.key }"
                @update="replaceChild(index, $event)"
                @remove="removeChild(index)"
              />
              <smart-opaque-row
                v-else
                :raw="node.raw"
                :readonly="readonly"
                @remove="removeChild(index)"
              />
            </template>
          </transition-group>

          <p v-if="!rules.children.length" class="text-body-medium text-medium-emphasis">
            {{ $t('smartPlaylists.noRulesYet') }}
          </p>

          <div v-if="!readonly" class="smart-editor__add">
            <v-btn prepend-icon="mdi-plus" variant="tonal" rounded="pill" @click="addRule">
              {{ $t('smartPlaylists.addCondition') }}
            </v-btn>
            <v-btn
              prepend-icon="mdi-format-list-group"
              variant="text"
              rounded="pill"
              @click="addGroup"
            >
              {{ $t('smartPlaylists.addGroup') }}
            </v-btn>
          </div>
        </section>

        <section class="beacon-panel">
          <smart-order-section
            :sort="rules.sort"
            :limit="rules.limit"
            :refresh-delay="rules.refreshDelay"
            :readonly="readonly"
            @update="rules = { ...rules, ...$event }"
          />
        </section>
      </div>

      <aside class="smart-editor__aside">
        <smart-preview-panel
          :preview="preview"
          :limit="rules.limit"
          :has-rules="rules.children.length > 0"
        />
      </aside>
    </div>

    <navidrome-password-dialog ref="password" />
  </v-container>
</template>

<script lang="ts">
import PlaylistCover from '@/components/library/PlaylistCover.vue'
import NavidromePasswordDialog from '@/components/smartPlaylist/NavidromePasswordDialog.vue'
import SmartConjunctionToggle from '@/components/smartPlaylist/SmartConjunctionToggle.vue'
import SmartOpaqueRow from '@/components/smartPlaylist/SmartOpaqueRow.vue'
import SmartOrderSection from '@/components/smartPlaylist/SmartOrderSection.vue'
import SmartPreviewPanel from '@/components/smartPlaylist/SmartPreviewPanel.vue'
import SmartRuleGroup from '@/components/smartPlaylist/SmartRuleGroup.vue'
import SmartRuleRow from '@/components/smartPlaylist/SmartRuleRow.vue'
import { createBackdropLayers, showBackdrop } from '@/services/crossfadeBackdrop'
import {
  NavidromeLoginRequired,
  createSmartPlaylist,
  getNavidromePlaylist,
  updateSmartPlaylist,
} from '@/services/navidrome/client'
import { PRESETS, type Preset } from '@/services/navidrome/presets'
import { previewRules, type Preview } from '@/services/navidrome/preview'
import {
  emptyRules,
  newGroup,
  newRule,
  parseRules,
  problems,
  serializeRules,
  type Problem,
  type SmartRules,
  type TopNode,
} from '@/services/navidrome/smartRules'
import { suggestionsFor, type Suggestion } from '@/services/navidrome/suggestions'
import { formatTotalDuration } from '@/services/totalDuration'
import { preloadImage } from '@/services/preloadImage'
import { useLibraryStore } from '@/stores/library'
import type { Playlist } from '@/types/library'

/** Long enough that typing a word does not rerun the preview per key,
 * short enough that it still answers "while typing". */
const PREVIEW_DELAY_MS = 150

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Creating a Navidrome smart playlist, or editing one's rules: the rules on
 * the left, written as sentences, and on the right what they would pick,
 * estimated from the library while they are written (see
 * docs/plans/smart-playlist-builder.md).
 *
 * Desktop only: the phone shell offers no way here, since a page this
 * dense does not fit a phone. A narrow window stacks the preview under the
 * rules instead.
 */
export default {
  name: 'SmartPlaylistEditorView',
  components: {
    NavidromePasswordDialog,
    PlaylistCover,
    SmartConjunctionToggle,
    SmartOpaqueRow,
    SmartOrderSection,
    SmartPreviewPanel,
    SmartRuleGroup,
    SmartRuleRow,
  },
  data() {
    return {
      rules: emptyRules() as SmartRules,
      name: '',
      nameTouched: false,
      /** The `.nsp` file the playlist comes from; empty for one made in a
       * client. Set means read-only: the next scan would overwrite. */
      filePath: '',
      loading: false,
      loadError: '',
      saving: false,
      saveError: '',
      /** Whether a save was tried, which is when problems are shown. */
      attempted: false,
      preview: null as Preview | null,
      previewTimer: null as number | null,
      /** The songs of playlists the rules refer to, for the preview. */
      playlistSongs: new Map<string, ReadonlySet<string>>(),
      backdrop: createBackdropLayers(),
      presets: PRESETS,
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
    playlistId(): string | null {
      const id = this.$route.params.id
      return typeof id === 'string' ? id : null
    },
    isNew(): boolean {
      return this.playlistId === null
    },
    readonly(): boolean {
      return this.filePath !== ''
    },
    problems(): Problem[] {
      return problems(this.rules)
    },
    invalidKeys(): number[] {
      if (!this.attempted) return []
      return this.problems.flatMap((problem) => ('key' in problem ? [problem.key] : []))
    },
    problemMessage(): string {
      if (!this.attempted || !this.problems.length) return ''
      return this.problems.some((problem) => problem.kind === 'noRules')
        ? this.$t('smartPlaylists.needsRule')
        : this.$t('smartPlaylists.incomplete')
    },
    playlistOptions(): Playlist[] {
      return this.libraryStore.playlists.filter((playlist) => playlist.id !== this.playlistId)
    },
    /** One cover per album the preview draws from, in its order. */
    previewCovers(): string[] {
      const covers: string[] = []
      const albums = new Set<string>()
      for (const song of this.preview?.songs ?? []) {
        if (!song.coverArtId || albums.has(song.albumId)) continue
        albums.add(song.albumId)
        covers.push(song.coverArtId)
        if (covers.length === 12) break
      }
      return covers
    },
    metaLine(): string {
      if (!this.preview) return ''
      const count = this.preview.songs.length
      const seconds = this.preview.songs.reduce((total, song) => total + song.duration, 0)
      const parts = [this.$t('playlists.songCount', { count })]
      if (seconds) parts.push(formatTotalDuration(seconds, this.$t))
      return parts.join(' · ')
    },
  },
  watch: {
    rules: {
      deep: true,
      handler() {
        this.schedulePreview()
      },
    },
    'libraryStore.allSongs'() {
      this.schedulePreview()
    },
    'previewCovers.0'(cover: string | undefined) {
      void this.showLeadCover(cover ?? null)
    },
    '$route.params.id'() {
      void this.load()
    },
  },
  created() {
    void this.load()
    // The preview, the value suggestions and the playlist picker read
    // these; each is cached and cheap when already loaded.
    void this.libraryStore.fetchAllSongs().catch(() => {})
    void this.libraryStore.fetchPlaylists().catch(() => {})
    void this.libraryStore.fetchArtists().catch(() => {})
  },
  beforeUnmount() {
    if (this.previewTimer) clearTimeout(this.previewTimer)
  },
  methods: {
    async load(): Promise<void> {
      this.loadError = ''
      this.saveError = ''
      this.attempted = false
      this.filePath = ''
      if (this.isNew) {
        this.rules = emptyRules()
        this.name = ''
        this.nameTouched = false
        return
      }
      const id = this.playlistId!
      this.loading = true
      try {
        const playlist = await getNavidromePlaylist(id)
        if (this.playlistId !== id) return
        this.rules = parseRules(playlist.rules)
        this.name = playlist.name
        this.nameTouched = true
        this.filePath = playlist.path ?? ''
      } catch (error) {
        if (error instanceof NavidromeLoginRequired) {
          if (await this.askPassword()) return this.load()
          this.leave()
          return
        }
        this.loadError = `${this.$t('smartPlaylists.loadFailed')}: ${errorText(error)}`
      } finally {
        this.loading = false
      }
    },
    askPassword(): Promise<boolean> {
      return (this.$refs.password as InstanceType<typeof NavidromePasswordDialog>).ask()
    },
    suggestionsFor(field: string): Suggestion[] {
      return suggestionsFor(field, this.libraryStore.allSongs, this.libraryStore.artists)
    },
    setChildren(children: TopNode[]): void {
      this.rules = { ...this.rules, children }
    },
    replaceChild(index: number, node: TopNode): void {
      const children = [...this.rules.children]
      children[index] = node
      this.setChildren(children)
    },
    removeChild(index: number): void {
      this.setChildren(this.rules.children.filter((_, at) => at !== index))
    },
    addRule(): void {
      this.setChildren([...this.rules.children, newRule()])
    },
    addGroup(): void {
      this.setChildren([...this.rules.children, newGroup()])
    },
    applyPreset(preset: Preset): void {
      this.rules = { ...this.rules, ...preset.build() }
      this.attempted = false
      if (!this.nameTouched) this.name = this.$t(`smartPlaylists.presets.${preset.id}`)
    },
    schedulePreview(): void {
      if (this.previewTimer) clearTimeout(this.previewTimer)
      this.previewTimer = window.setTimeout(() => {
        this.previewTimer = null
        this.updatePreview()
      }, PREVIEW_DELAY_MS)
    },
    updatePreview(): void {
      if (!this.libraryStore.allSongsLoaded) return
      void this.loadReferencedPlaylists()
      this.preview = previewRules(this.rules, this.libraryStore.allSongs, {
        now: Date.now(),
        playlistSongs: this.playlistSongs,
      })
    },
    /** Fetches the songs of playlists the rules name, once each, and runs
     * the preview again when they arrive. */
    async loadReferencedPlaylists(): Promise<void> {
      const ids = new Set<string>()
      const collect = (node: TopNode) => {
        if (node.type === 'rule' && node.field === 'playlist' && typeof node.value === 'string') {
          ids.add(node.value)
        } else if (node.type === 'group') {
          node.children.forEach(collect)
        }
      }
      this.rules.children.forEach(collect)
      const missing = [...ids].filter((id) => !this.playlistSongs.has(id))
      if (!missing.length) return
      for (const id of missing) {
        try {
          const playlist = await this.libraryStore.fetchPlaylist(id)
          this.playlistSongs.set(id, new Set(playlist.songs.map((song) => song.id)))
        } catch (error) {
          console.error('[smart-editor] Playlist for the preview failed:', error)
        }
      }
      this.schedulePreview()
    },
    async showLeadCover(cover: string | null): Promise<void> {
      const url = cover ? this.libraryStore.client().coverArtUrl(cover, 300) : null
      if (url) await preloadImage(url)
      if ((this.previewCovers[0] ?? null) === cover) showBackdrop(this.backdrop, url)
    },
    async save(): Promise<void> {
      this.attempted = true
      this.saveError = ''
      if (this.problems.length || this.saving) return
      this.saving = true
      const name = this.name.trim() || this.$t('smartPlaylists.defaultName')
      try {
        const rules = serializeRules(this.rules)
        let id = this.playlistId
        if (id) await updateSmartPlaylist(id, { name, rules })
        else id = await createSmartPlaylist({ name, rules, public: false })
        await this.libraryStore.fetchPlaylists(true)
        this.$router.replace(this.detailRoute(id))
      } catch (error) {
        if (error instanceof NavidromeLoginRequired) {
          this.saving = false
          if (await this.askPassword()) return this.save()
          return
        }
        this.saveError = `${this.$t('smartPlaylists.saveFailed')}: ${errorText(error)}`
      } finally {
        this.saving = false
      }
    },
    detailRoute(id: string) {
      return { name: 'playlist-detail', params: { id } }
    },
    leave(): void {
      if (this.playlistId) this.$router.replace(this.detailRoute(this.playlistId))
      else this.$router.replace({ name: 'playlists' })
    },
  },
}
</script>

<style scoped>
/* ── The header ─────────────────────────────────────────────────────────
 * DetailHeader's look (docs/styleguide.md, "The artwork backdrop") rather
 * than DetailHeader itself: its name is a heading, and here it is the field
 * the playlist is named in. */
.smart-editor__hero {
  position: relative;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--beacon-hairline);
  margin-bottom: 20px;
  isolation: isolate;
}

.smart-editor__backdrop {
  position: absolute;
  inset: -20px;
  background-image: var(--backdrop-image);
  background-size: cover;
  background-position: center;
  filter: blur(38px) saturate(1.4) brightness(0.55);
  transform: scale(1.15);
  opacity: 0;
  transition: opacity 0.6s;
  z-index: -2;
}

.smart-editor__backdrop--active {
  opacity: 1;
}

.smart-editor__scrim {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      120deg,
      rgba(18, 20, 28, 0.94),
      rgba(18, 20, 28, 0.74) 48%,
      rgba(245, 169, 78, 0.18)
    ),
    linear-gradient(to bottom, transparent 55%, rgba(18, 20, 28, 0.55));
  z-index: -1;
}

.smart-editor__hero-content {
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 28px;
}

.smart-editor__cover {
  flex: 0 0 auto;
}

.smart-editor__heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

/* The name looks like the title it becomes, and only shows it is a field
 * when pointed at or typed in. Its text clears the 16px floor many times
 * over (docs/styleguide.md, "The one type floor"). */
.smart-editor__name {
  width: 100%;
  min-width: 0;
  padding: 2px 8px;
  margin-left: -8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  outline: none;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}

.smart-editor__name::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.4);
}

.smart-editor__name:not([readonly]):hover {
  background: rgba(255, 255, 255, 0.04);
}

.smart-editor__name:not([readonly]):focus {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--beacon-hairline);
}

.smart-editor__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.smart-editor__notice {
  margin-bottom: 16px;
}

.smart-editor__loading {
  display: flex;
  justify-content: center;
  padding: 48px 0;
}

/* ── Rules and preview ──────────────────────────────────────────────────
 * Side by side where both fit; the preview stays in view while the rules
 * scroll. Measured on the page's own width, not the window's, so the queue
 * drawer opening beside it is taken into account. */
.smart-editor {
  container-type: inline-size;
}

.smart-editor__body {
  display: grid;
  /* Wide enough for a song title and its artist to mostly fit. */
  grid-template-columns: minmax(0, 1fr) 400px;
  gap: 20px;
  align-items: start;
}

@container (max-width: 900px) {
  .smart-editor__body {
    grid-template-columns: minmax(0, 1fr);
  }

  /* Under the rules now, so nothing for it to stay beside. */
  .smart-editor__aside {
    position: static;
  }
}

.smart-editor__main {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.smart-editor__aside {
  position: sticky;
  top: calc(var(--beacon-sticky-top, var(--v-layout-top, 0px)) + 16px);
}

.smart-editor__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.smart-editor__rules {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.smart-editor__sentence {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 1.05rem;
}

.smart-editor__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.smart-editor__culprit {
  outline: 1px solid rgba(var(--v-theme-primary), 0.55);
}

.smart-editor__add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.smart-editor__add :deep(.v-btn),
.smart-editor__actions :deep(.v-btn) {
  text-transform: none;
  letter-spacing: normal;
}

/* Rows arriving and leaving: the queue's own 0.3s in, 0.2s out. */
.smart-row-enter-active {
  transition:
    opacity 0.3s,
    transform 0.3s;
}

.smart-row-leave-active {
  transition: opacity 0.2s;
}

.smart-row-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.smart-row-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .smart-editor__backdrop,
  .smart-row-enter-active,
  .smart-row-leave-active {
    transition: none;
  }
}

@container (max-width: 600px) {
  .smart-editor__hero-content {
    gap: 16px;
    padding: 18px;
  }

  .smart-editor__name {
    font-size: 1.6rem;
  }
}
</style>
