<template>
  <div>
    <track-list-header
      :class="{ 'track-list-header--sticky': stickyHeader }"
      :show-cover="showCover"
      :show-album="showAlbum"
      :show-genre="showGenre"
      :show-year="showYear"
      :show-play-count="showPlayCount"
      :show-format="showFormat"
      :sort-key="sortKey"
      :sort-direction="sortDirection"
      @sort="onSort"
    />
    <template v-if="loading">
      <div
        v-for="n in skeletonRowCount"
        :key="n"
        class="track-row track-row--skeleton d-flex align-center px-2 py-1"
      >
        <div class="track-index" />
        <v-skeleton-loader v-if="showCover" type="image" width="40" height="40" class="rounded" />
        <div class="track-title min-width-0">
          <v-skeleton-loader type="text" width="60%" height="20" />
          <v-skeleton-loader type="text" width="38%" height="20" />
        </div>
        <div v-if="showAlbum" class="track-album">
          <v-skeleton-loader type="text" width="70%" height="20" />
        </div>
        <div v-if="showGenre" class="track-genre">
          <v-skeleton-loader type="text" width="60%" height="20" />
        </div>
        <div v-if="showYear" class="track-year">
          <v-skeleton-loader type="text" width="28" height="20" class="ml-auto" />
        </div>
        <div v-if="showPlayCount" class="track-playcount">
          <v-skeleton-loader type="text" width="20" height="20" class="ml-auto" />
        </div>
        <div v-if="showFormat" class="track-format">
          <v-skeleton-loader type="text" width="60" height="20" class="ml-auto" />
        </div>
        <div class="track-duration">
          <v-skeleton-loader type="text" width="30" height="20" class="ml-auto" />
        </div>
        <div class="track-actions" style="width: 200px" />
      </div>
    </template>
    <template v-else-if="showDiscGroups">
      <template v-for="group in discGroups" :key="group.discNumber">
        <div class="disc-header text-caption text-medium-emphasis">
          {{ $t('library.disc', { number: group.discNumber }) }}
        </div>
        <track-row
          v-for="row in group.rows"
          :key="`${row.track.id}-${row.index}`"
          :track="row.track"
          :index="row.index"
          :display-number="row.track.trackNumber ?? row.index + 1"
          :show-cover="showCover"
          :show-album="showAlbum"
          :show-genre="showGenre"
          :show-year="showYear"
          :show-play-count="showPlayCount"
          :show-format="showFormat"
          :selection-mode="selectionMode"
          :selected="selectedRowKeys.has(row.index)"
          @play="playTrack"
          @play-next="playNextTrack"
          @track-radio="startTrackRadio"
          @toggle-star="toggleStar"
          @set-rating="setRating"
          @add-to-queue="addToQueue"
          @add-to-playlist="addToPlaylist"
          @create-playlist="openCreatePlaylistDialog"
          @toggle-select="toggleSelect"
        />
      </template>
    </template>
    <template v-else>
      <track-row
        v-for="(track, index) in visibleTracks"
        :key="`${track.id}-${index}`"
        :track="track"
        :index="rowIndexOffset + index"
        :show-cover="showCover"
        :show-album="showAlbum"
        :show-genre="showGenre"
        :show-year="showYear"
        :show-play-count="showPlayCount"
        :show-format="showFormat"
        :selection-mode="selectionMode"
        :selected="selectedRowKeys.has(rowIndexOffset + index)"
        @play="playTrack"
        @play-next="playNextTrack"
        @track-radio="startTrackRadio"
        @toggle-star="toggleStar"
        @set-rating="setRating"
        @add-to-queue="addToQueue"
        @add-to-playlist="addToPlaylist"
        @create-playlist="openCreatePlaylistDialog"
        @toggle-select="toggleSelect"
      />
    </template>
    <div
      v-if="!disablePagination && !infiniteScroll && pageCount > 1"
      class="d-flex justify-center mt-3"
    >
      <v-pagination
        v-model="currentPage"
        :length="pageCount"
        :total-visible="7"
        density="comfortable"
      />
    </div>
    <infinite-scroll-trigger
      v-if="infiniteScroll && visibleCount < sortedTracks.length"
      @trigger="loadMoreVisible"
    />

    <!-- Floating, not part of document flow (position: fixed, see <style>
     - below) — TrackList gets embedded in all sorts of different page
     - layouts, so anchoring this to the list itself would mean re-deriving
     - "is this actually still on screen" per context. Fixed to the
     - viewport bottom (offset above PlayerBar) works the same everywhere
     - it's used. -->
    <v-slide-y-reverse-transition>
      <div v-if="selectionMode" class="selection-bar">
        <span class="text-body-2">
          {{ selectedRowKeys.size }}
          {{ selectedRowKeys.size === 1 ? $t('library.track1') : $t('library.tracksN') }}
          {{ $t('library.selected') }}
        </span>
        <v-btn variant="text" prepend-icon="mdi-skip-next-outline" @click="bulkPlayNext">
          {{ $t('library.playNext') }}
        </v-btn>
        <v-btn variant="text" prepend-icon="mdi-playlist-plus" @click="bulkAddToQueue">
          {{ $t('common.addToQueue') }}
        </v-btn>
        <!-- No "Add to Playlist" button here — a selected row's own "..."
         - menu (TrackRow.vue) already has one, and applies it to the whole
         - selection instead of just that row once it's part of one (see
         - selectedOrSingle() below). Keeping a second, separate playlist
         - submenu here just to duplicate that would only be one more
         - place for its own quirks (its height-limited scrolling, its own
         - "no playlists yet" state, ...) to drift out of sync with the
         - original. -->
        <v-btn
          icon="mdi-close"
          variant="text"
          density="comfortable"
          :title="$t('library.clearSelection')"
          @click="clearSelection"
        />
      </div>
    </v-slide-y-reverse-transition>

    <!-- Reached from a row's own "..." menu -> "Add to playlist" ->
     - "Create new playlist" (TrackRow.vue) — pre-seeds the new playlist
     - with whatever track(s) triggered it instead of creating an empty
     - one, which some backends can't even do at all (Plex's playlist
     - endpoint requires at least one starting item; see
     - media/plex_bridge.py's create_playlist()). -->
    <v-dialog v-model="createPlaylistDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('playlists.createTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="createPlaylistName"
            :label="$t('common.name')"
            variant="solo-filled"
            autofocus
            clearable
            @keyup.enter="confirmCreatePlaylist"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createPlaylistDialog = false">{{
            $t('common.cancel')
          }}</v-btn>
          <v-btn color="primary" @click="confirmCreatePlaylist">{{ $t('common.create') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { usePlaybackStore } from '@/stores/playback'
import { useLibraryStore } from '@/stores/library'
import TrackRow from './TrackRow.vue'
import TrackListHeader from './TrackListHeader.vue'
import InfiniteScrollTrigger from '@/components/InfiniteScrollTrigger.vue'
import type { Track } from '@/types/library'

type SortKey = 'title' | 'album' | 'genre' | 'year' | 'playCount' | 'format' | 'duration' | 'rating'

const PAGE_SIZE = 100

export default {
  name: 'TrackList',
  components: { TrackRow, TrackListHeader, InfiniteScrollTrigger },
  props: {
    // Pass the complete list this view has (not a pre-sliced page) —
    // sorting and render-pagination both happen inside this component, in
    // that order, so a column sort always spans everything given here, and
    // "Mehr laden" only ever grows how much of the (already sorted) result
    // is rendered.
    tracks: {
      type: Array as () => Track[],
      required: true,
    },
    showCover: { type: Boolean, default: false },
    showAlbum: { type: Boolean, default: false },
    showGenre: { type: Boolean, default: false },
    showYear: { type: Boolean, default: false },
    showPlayCount: { type: Boolean, default: false },
    showFormat: { type: Boolean, default: false },
    // Overridable for views that hand over an already-meaningfully-ordered
    // list — null means "leave it in the order the list was given in" (no
    // column highlighted as active), used by album/playlist detail so
    // track-number/playlist order is what actually plays, not an
    // alphabetical-by-title reshuffle. ArtistDetailView's/HomeView's "most
    // played" shelves instead pass 'playCount' (server-sorted desc).
    // Everywhere else without an override defaults to title, so a plain
    // library browse isn't just "whatever order the API happened to
    // return".
    defaultSortKey: { type: String as PropType<SortKey | null>, default: 'title' },
    defaultSortDirection: { type: String as () => 'asc' | 'desc', default: 'asc' },
    // Opt-in: replaces the v-pagination page-number nav with an
    // auto-load-more-on-scroll sentinel instead. Off by default — the
    // page-number nav is deliberate for most call sites (album/playlist/
    // genre detail, search, favorites — all reasonably small lists), this
    // is for the few top-level browse views with genuinely long lists
    // (TracksView) where scrolling to the bottom and clicking through pages
    // is more friction than it's worth.
    infiniteScroll: { type: Boolean, default: false },
    // Whether clicking a track queues the rest of this list too (true,
    // default) or just that one track (false). Set to false for raw
    // library-browse views whose list isn't a curated sequence and can run
    // into the thousands (TracksView, GenreDetailView) — everywhere else
    // (album/playlist/artist detail, favorites, search, home shelves) is a
    // bounded, intentional list, so playing through it is the expected
    // behavior, same as any other music player.
    queueWholeList: { type: Boolean, default: true },
    // Renders placeholder rows matching TrackRow's column layout instead of
    // the real (still-loading) tracks — avoids the height jump of swapping
    // a spinner for a full table once data arrives.
    loading: { type: Boolean, default: false },
    // Pins the column-label row so it stays visible while scrolling through
    // a long list, right below whatever the page's own sticky title/filter
    // block is (its height is passed in via the --sticky-header-offset CSS
    // var, set on this component's root — see TracksView.vue). Off by
    // default since it only makes sense for pages that actually have a
    // sticky block above the list (currently just TracksView).
    stickyHeader: { type: Boolean, default: false },
    // Album detail's own opt-in — groups rows under a "Disc N" header per
    // distinct discNumber instead of one flat sequence. Only actually
    // takes effect while sorted in natural order (see showDiscGroups) and
    // when the tracks given actually span more than one disc — a
    // single-disc album (the common case) doesn't grow a redundant "Disc
    // 1" heading. Not the default for every TrackList consumer since
    // grouping by disc only means anything for a single album's own
    // tracks — a playlist/search/queue list can mix tracks from many
    // different albums, where "disc number" isn't a meaningful grouping.
    groupByDisc: { type: Boolean, default: false },
    // Album detail's own opt-in — an album (even a large box set) is a
    // small, bounded list where paging through it is more friction than
    // it's worth; just render every track. Also sidesteps disc groups
    // (see groupByDisc) getting split across pages, since discGroups only
    // ever sees the current page's worth of visibleTracks.
    disablePagination: { type: Boolean, default: false },
  },
  data() {
    return {
      sortKey: this.defaultSortKey as SortKey | null,
      sortDirection: this.defaultSortDirection as 'asc' | 'desc',
      currentPage: 1,
      visibleCount: PAGE_SIZE,
      // Set by onSort() the moment the user picks a column themselves —
      // from then on the defaultSortKey watcher below must leave sortKey
      // alone. Without this, sorting a still-loading TracksView by
      // anything other than the eventual default (e.g. clicking "Album"
      // while fetchAllTracks() is still streaming in pages) got silently
      // discarded the instant loading finished and defaultSortKey flipped
      // from null to 'title' — the view snapped back to title-sort with
      // no visible cause, looking like "sorting only ever covered
      // whatever had loaded so far".
      userChangedSort: false,
      // Guards toggleStar() against a rapid double-click flipping the same
      // track twice concurrently, which (since both calls read `starred`
      // before either resolves) can leave the local state one flip behind
      // what the server actually recorded.
      starringTrackIds: new Set<string>(),
      // Row positions (index within sortedTracks), not track ids — a track
      // can appear more than once in the same list (e.g. a playlist with a
      // song added twice), and an id-keyed Set would make toggling one
      // occurrence's checkbox also mark every other row sharing that id as
      // selected. See selectedTracks for resolving these back to real
      // Track objects when a bulk action needs them.
      selectedRowKeys: new Set<number>(),
      createPlaylistDialog: false,
      createPlaylistName: '',
      // Set by openCreatePlaylistDialog() — the track(s) (selection-aware,
      // same as addToPlaylist()) to seed the new playlist with once
      // confirmCreatePlaylist() actually creates it.
      createPlaylistTracks: [] as Track[],
    }
  },
  computed: {
    skeletonRowCount(): number {
      return Math.min(this.tracks.length || 8, 8)
    },
    playbackStore() {
      return usePlaybackStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    // Selecting even one row switches every row into "selection mode" (see
    // TrackRow.vue's own selectionMode prop) — showing every checkbox, not
    // just the currently-hovered row's, so the rest of a multi-track
    // selection can be built up without hunting for each row individually.
    selectionMode(): boolean {
      return this.selectedRowKeys.size > 0
    },
    // Resolved in list order (not selection order) so "Add to Queue"
    // queues tracks the same way clicking through the list would.
    selectedTracks(): Track[] {
      return this.sortedTracks.filter((_track, index) => this.selectedRowKeys.has(index))
    },
    sortedTracks(): Track[] {
      if (!this.sortKey) return this.tracks
      const key = this.sortKey
      const dir = this.sortDirection === 'desc' ? -1 : 1
      return [...this.tracks].sort((a, b) => {
        const av = this.sortValue(a, key)
        const bv = this.sortValue(b, key)
        if (av < bv) return -1 * dir
        if (av > bv) return 1 * dir
        return 0
      })
    },
    pageCount(): number {
      return Math.max(1, Math.ceil(this.sortedTracks.length / PAGE_SIZE))
    },
    pageOffset(): number {
      return (this.currentPage - 1) * PAGE_SIZE
    },
    visibleTracks(): Track[] {
      if (this.disablePagination) {
        return this.sortedTracks
      }
      if (this.infiniteScroll) {
        return this.sortedTracks.slice(0, this.visibleCount)
      }
      return this.sortedTracks.slice(this.pageOffset, this.pageOffset + PAGE_SIZE)
    },
    rowIndexOffset(): number {
      return this.disablePagination || this.infiniteScroll ? 0 : this.pageOffset
    },
    // Grouping only makes visual sense in the tracks' own natural order —
    // sorting by title/duration/etc. would otherwise scatter one disc's
    // rows across several disconnected "Disc N" sections.
    showDiscGroups(): boolean {
      return this.groupByDisc && !this.sortKey && this.discGroups.length > 1
    },
    discGroups(): { discNumber: number; rows: { track: Track; index: number }[] }[] {
      const groups = new Map<number, { track: Track; index: number }[]>()
      this.visibleTracks.forEach((track, i) => {
        const disc = track.discNumber ?? 1
        const rows = groups.get(disc) ?? []
        rows.push({ track, index: this.rowIndexOffset + i })
        groups.set(disc, rows)
      })
      return [...groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([discNumber, rows]) => ({ discNumber, rows }))
    },
  },
  watch: {
    // A new track list (different filter, different album, ...) or a new
    // sort both invalidate which page was open / how much was revealed —
    // and, since selectedRowKeys is keyed by position within sortedTracks
    // (see its own comment), also invalidate any existing selection: the
    // same indices would now silently point at different tracks.
    tracks() {
      this.currentPage = 1
      this.visibleCount = PAGE_SIZE
      this.clearSelection()
    },
    sortKey() {
      this.currentPage = 1
      this.visibleCount = PAGE_SIZE
      this.clearSelection()
    },
    sortDirection() {
      this.clearSelection()
    },
    // Lets a caller change the *effective* default after mount — used by
    // TracksView to keep the list in stable arrival order (sortKey null,
    // new tracks only ever append) while its background-paginated fetch is
    // still streaming in more of the catalog, then switch to the real
    // alphabetical default in one clean transition once that's done,
    // instead of re-sorting (and visibly reshuffling already-visible rows)
    // on every single page that arrives in between.
    defaultSortKey(value: SortKey | null) {
      // See userChangedSort's own comment — a prop-driven default change
      // (loading finishing, a route swapping which list is shown) only
      // applies while the user hasn't taken the wheel themselves.
      if (this.userChangedSort) return
      this.sortKey = value
    },
  },
  methods: {
    loadMoreVisible() {
      this.visibleCount += PAGE_SIZE
    },
    sortValue(track: Track, key: SortKey): string | number {
      // Format has no single natural sort order of its own — bitrate is the
      // meaningful "quality" ranking underneath that column.
      if (key === 'format') return track.bitRate ?? 0
      const value = track[key]
      if (typeof value === 'string') return value.toLowerCase()
      return value ?? 0
    },
    onSort(key: SortKey) {
      this.userChangedSort = true
      if (this.sortKey === key) {
        this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc'
      } else {
        this.sortKey = key
        this.sortDirection = 'asc'
      }
    },
    playTrack(track: Track, index: number | null) {
      if (!this.queueWholeList) {
        // Raw library browsing (Tracks/Genre views) — not a curated
        // sequence, so only the clicked track goes into the queue, not the
        // rest of a list that can run into the thousands. Use the context
        // menu's "Play next" to queue more, or "Track Radio" to build a
        // queue out of similar tracks.
        void this.playbackStore.playTrackList([track], 0)
        return
      }
      // A curated, bounded list (album/playlist/favorites/search/...) —
      // clicking a track plays it and continues through the rest, same as
      // any other music player. Uses the row's own absolute index (passed
      // through from TrackRow) rather than re-deriving it by id — a
      // findIndex-by-id would always resolve to the *first* occurrence,
      // playing the wrong position when the same track appears twice in
      // one list (e.g. concatenated from two playlists).
      const position = index ?? this.sortedTracks.findIndex((t) => t.id === track.id)
      void this.playbackStore.playTrackList(this.sortedTracks, Math.max(0, position))
    },
    playNextTrack(track: Track, index?: number) {
      this.playbackStore.queueNext(this.selectedOrSingle(track, index))
    },
    async startTrackRadio(track: Track) {
      try {
        await this.playbackStore.startTrackRadio(track)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.trackRadio'),
          message: this.$t('library.trackRadioError'),
        })
        console.error('[track-radio]', error)
      }
    },
    async toggleStar(track: Track) {
      if (this.starringTrackIds.has(track.id)) return
      this.starringTrackIds.add(track.id)
      const wasStarred = track.starred
      try {
        await this.libraryStore.toggleStar({ id: track.id, starred: wasStarred })
        track.starred = !wasStarred
      } finally {
        this.starringTrackIds.delete(track.id)
      }
    },
    async setRating({ track, rating }: { track: Track; rating: number }) {
      const previous = track.rating
      track.rating = rating
      try {
        await this.libraryStore.setRating(track.id, rating)
      } catch (error) {
        track.rating = previous
        console.error('[track-list] Failed to set rating:', error)
      }
    },
    addToQueue(track: Track, index?: number) {
      this.playbackStore.addToQueue(this.selectedOrSingle(track, index))
    },
    async addToPlaylist({
      track,
      playlistId,
      index,
    }: {
      track: Track
      playlistId: string
      index?: number
    }) {
      const tracks = this.selectedOrSingle(track, index)
      await this.libraryStore.addToPlaylist(
        playlistId,
        tracks.map((t) => t.id),
      )
    },
    openCreatePlaylistDialog({ track, index }: { track: Track; index?: number }) {
      this.createPlaylistTracks = this.selectedOrSingle(track, index)
      this.createPlaylistName = ''
      this.createPlaylistDialog = true
    },
    async confirmCreatePlaylist() {
      if (!this.createPlaylistName.trim()) return
      try {
        await this.libraryStore.createPlaylist(
          this.createPlaylistName,
          this.createPlaylistTracks.map((t) => t.id),
        )
        this.createPlaylistDialog = false
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.createTitle'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[track-list] Failed to create playlist:', error)
      }
    },
    // A row's own actions (play-next/add-to-queue/add-to-playlist, all via
    // TrackRow.vue's "..." menu) apply to the *whole* current selection
    // once the row they were triggered from is part of one — the same
    // "act on the selection, not just what you clicked" convention as a
    // file manager's right-click menu. Acting on a row that isn't
    // selected (or when nothing's selected at all) still just means that
    // one track, same as before multiselect existed.
    selectedOrSingle(track: Track, index?: number): Track[] {
      return this.selectionMode && index != null && this.selectedRowKeys.has(index)
        ? this.selectedTracks
        : [track]
    },
    toggleSelect(_track: Track, index: number) {
      if (this.selectedRowKeys.has(index)) {
        this.selectedRowKeys.delete(index)
      } else {
        this.selectedRowKeys.add(index)
        // Same "fetch eagerly once selection starts" reasoning as
        // TrackRow's own openMenu() — the playlist submenu below shouldn't
        // open empty on the very first use just because nothing had
        // fetched it yet.
        if (this.libraryStore.playlists.length === 0) {
          void this.libraryStore.fetchPlaylists()
        }
      }
    },
    // Deliberately doesn't clear the selection afterwards — either bulk
    // action can be followed by the other (e.g. queue a batch, then also
    // file it into a playlist via a selected row's own "..." menu, see
    // selectedOrSingle()) without having to reselect the same tracks. Only
    // the bar's own close button (clearSelection) ends a selection.
    bulkAddToQueue() {
      this.playbackStore.addToQueue(this.selectedTracks)
    },
    bulkPlayNext() {
      this.playbackStore.queueNext(this.selectedTracks)
    },
    clearSelection() {
      this.selectedRowKeys.clear()
    },
  },
}
</script>

<style scoped>
/* Column widths/flex mirror TrackRow.vue's so a skeleton row lines up with
 * the real rows that replace it once loading finishes. */
.track-row {
  gap: 12px;
}

.track-index {
  flex: 0 0 28px;
}

.track-cover {
  flex: 0 0 auto;
}

.track-title {
  flex: 3 1 160px;
}

.track-album {
  flex: 2 1 120px;
  min-width: 0;
}

.track-genre {
  flex: 1.5 1 90px;
  min-width: 0;
}

.track-year,
.track-playcount,
.track-format,
.track-duration {
  flex: 0 0 44px;
}

.track-format {
  flex-basis: 120px;
}

.track-actions {
  flex: 0 0 200px;
}

.disc-header {
  padding: 12px 8px 4px;
  font-weight: 600;
}

/* v-skeleton-loader's "image"/"text" bones ignore the component's own
 * width/height props (fixed CSS height + a 16px margin baked in) — those
 * props only size the outer wrapper. Forcing the bone to fill that wrapper
 * exactly is what makes each skeleton cell match TrackRow.vue's real
 * dimensions (40px cover, 20px text lines) pixel for pixel, so the row
 * height (48px, py-1 + the 40px cover/title-block) never shifts once real
 * rows render in. */
.track-row--skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}

.min-width-0 {
  min-width: 0;
}

/* Pins the column-label row right below the page's own sticky title/filter
 * block — --sticky-header-offset is set on this component's root by the
 * consuming view (see TracksView.vue), and --v-layout-top is Vuetify's own
 * app-bar-height variable, so this stays correct regardless of app-bar
 * density or how tall the filter block above it happens to be. :deep()
 * because the sticky class lands on TrackListHeader's own root element,
 * outside this component's own scoped template. */
:deep(.track-list-header--sticky) {
  position: sticky;
  top: calc(var(--v-layout-top, 0px) + var(--sticky-header-offset, 0px));
  z-index: 2;
  background: rgb(var(--v-theme-background));
  /* Forces its own compositing layer — without this, Chromium sometimes
   * renders position:sticky content with a faint 1px wobble while scrolling
   * (the compositor and main thread disagree on the sub-pixel offset for a
   * frame or two). */
  transform: translateZ(0);
}

/* Fixed to the viewport, not this component's own layout — TrackList gets
 * embedded at all sorts of scroll depths across different pages, so this
 * always ends up in the same comfortable spot regardless. Offset above
 * PlayerBar.vue's own fixed 88px height (see its :height prop) plus a
 * small gap, so it never sits on top of the transport controls; same
 * z-index as toast.vue's stack (the only other fixed-to-viewport UI here)
 * for consistency, comfortably above ordinary page content either way. */
.selection-bar {
  position: fixed;
  left: 50%;
  bottom: 104px;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 9999px;
  background: #1a1d27;
  border: 1px solid var(--beacon-hairline);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
</style>
