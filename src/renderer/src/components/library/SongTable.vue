<template>
  <div :class="{ 'song-table--with-alphabet-bar': showAlphabetBar }">
    <song-table-header
      :class="{ 'song-table-header--sticky': stickyHeader }"
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
        class="song-row song-row--skeleton d-flex align-center px-2 py-1"
      >
        <div class="song-index" />
        <v-skeleton-loader v-if="showCover" type="image" width="40" height="40" class="rounded" />
        <div class="song-title min-width-0">
          <v-skeleton-loader type="text" width="60%" height="20" />
          <v-skeleton-loader type="text" width="38%" height="20" />
        </div>
        <div v-if="showAlbum" class="song-album">
          <v-skeleton-loader type="text" width="70%" height="20" />
        </div>
        <div v-if="showGenre" class="song-genre">
          <v-skeleton-loader type="text" width="60%" height="20" />
        </div>
        <div v-if="showYear" class="song-year">
          <v-skeleton-loader type="text" width="28" height="20" class="ml-auto" />
        </div>
        <div v-if="showPlayCount" class="song-playcount">
          <v-skeleton-loader type="text" width="20" height="20" class="ml-auto" />
        </div>
        <div v-if="showFormat" class="song-format">
          <v-skeleton-loader type="text" width="60" height="20" class="ml-auto" />
        </div>
        <div class="song-duration">
          <v-skeleton-loader type="text" width="30" height="20" class="ml-auto" />
        </div>
        <div class="song-actions" style="width: 200px" />
      </div>
    </template>
    <template v-else-if="showDiscGroups">
      <template v-for="group in discGroups" :key="group.discNumber">
        <div class="disc-header text-body-small text-medium-emphasis">
          {{ $t('library.disc', { number: group.discNumber }) }}
        </div>
        <song-row
          v-for="row in group.rows"
          :key="`${row.song.id}-${row.index}`"
          :song="row.song"
          :index="row.index"
          :display-number="row.song.trackNumber ?? row.index + 1"
          :show-cover="showCover"
          :show-album="showAlbum"
          :show-genre="showGenre"
          :show-year="showYear"
          :show-play-count="showPlayCount"
          :show-format="showFormat"
          :selection-mode="selectionMode"
          :reorderable="canReorder"
          :drag-over-position="dragOverPosition(row.index)"
          :dragging="dragIndex === row.index"
          :selected="selectedRowKeys.has(row.index)"
          :selected-count="selectedRowKeys.size"
          @play="playSong"
          @play-next="playNextSong"
          @song-radio="startSongRadio"
          @toggle-star="toggleStar"
          @set-rating="setRating"
          @add-to-queue="addToQueue"
          @add-to-playlist="addToPlaylist"
          @create-playlist="openCreatePlaylistDialog"
          @toggle-select="toggleSelect"
          @dragstart="onRowDragStart"
          @dragover="onRowDragOver"
          @dragleave="onRowDragLeave"
          @drop="onRowDrop"
          @dragend="onRowDragEnd"
        />
      </template>
    </template>
    <!-- Past SONG_VIRTUALIZE_THRESHOLD (any list here — every SongTable
     - consumer renders the load-more-on-scroll way now, see visibleSongs'
     - own comment), switches from incrementally-growing plain rows to
     - v-virtual-scroll instead of mounting the entire list at once — same
     - reasoning as QueueDrawer.vue's QUEUE_VIRTUALIZE_THRESHOLD: that's the
     - mount-everything pattern which froze/crashed the renderer there once
     - a list ran into the tens of thousands. renderless — none of these
     - views box the table into a fixed-height scroll area of its own, the
     - whole page scrolls, so this rides that scroll parent
     - (document.documentElement) instead. -->
    <v-virtual-scroll
      v-else-if="virtualizeSongs"
      ref="virtualScroll"
      renderless
      :items="sortedSongs"
      item-height="48"
    >
      <template #default="{ item: song, index }">
        <song-row
          :key="`${song.id}-${index}`"
          :song="song"
          :index="index"
          :show-cover="showCover"
          :show-album="showAlbum"
          :show-genre="showGenre"
          :show-year="showYear"
          :show-play-count="showPlayCount"
          :show-format="showFormat"
          :selection-mode="selectionMode"
          :reorderable="canReorder"
          :drag-over-position="dragOverPosition(index)"
          :dragging="dragIndex === index"
          :selected="selectedRowKeys.has(index)"
          :selected-count="selectedRowKeys.size"
          @play="playSong"
          @play-next="playNextSong"
          @song-radio="startSongRadio"
          @toggle-star="toggleStar"
          @set-rating="setRating"
          @add-to-queue="addToQueue"
          @add-to-playlist="addToPlaylist"
          @create-playlist="openCreatePlaylistDialog"
          @toggle-select="toggleSelect"
          @dragstart="onRowDragStart"
          @dragover="onRowDragOver"
          @dragleave="onRowDragLeave"
          @drop="onRowDrop"
          @dragend="onRowDragEnd"
        />
      </template>
    </v-virtual-scroll>
    <template v-else>
      <song-row
        v-for="(song, index) in visibleSongs"
        :key="`${song.id}-${index}`"
        :data-song-index="index"
        :song="song"
        :index="index"
        :show-cover="showCover"
        :show-album="showAlbum"
        :show-genre="showGenre"
        :show-year="showYear"
        :show-play-count="showPlayCount"
        :show-format="showFormat"
        :selection-mode="selectionMode"
        :reorderable="canReorder"
        :drag-over-position="dragOverPosition(index)"
        :dragging="dragIndex === index"
        :selected="selectedRowKeys.has(index)"
        :selected-count="selectedRowKeys.size"
        @play="playSong"
        @play-next="playNextSong"
        @song-radio="startSongRadio"
        @toggle-star="toggleStar"
        @set-rating="setRating"
        @add-to-queue="addToQueue"
        @add-to-playlist="addToPlaylist"
        @create-playlist="openCreatePlaylistDialog"
        @toggle-select="toggleSelect"
        @dragstart="onRowDragStart"
        @dragover="onRowDragOver"
        @dragleave="onRowDragLeave"
        @drop="onRowDrop"
        @dragend="onRowDragEnd"
      />
    </template>
    <infinite-scroll-trigger
      v-if="!virtualizeSongs && visibleCount < sortedSongs.length"
      @trigger="loadMoreVisible"
    />

    <alphabet-index-bar
      v-if="showAlphabetBar"
      :available="availableLetters"
      @select="jumpToLetter"
    />

    <!-- Reached from a row's own "..." menu -> "Add to playlist" ->
     - "Create new playlist" (SongRow.vue) — pre-seeds the new playlist
     - with whatever song(s) triggered it instead of creating an empty
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
import { firstIndexByLetter } from '@/services/alphabetIndex'
import SongRow from './SongRow.vue'
import SongTableHeader from './SongTableHeader.vue'
import AlphabetIndexBar from './AlphabetIndexBar.vue'
import InfiniteScrollTrigger from '@/components/InfiniteScrollTrigger.vue'
import type { Song } from '@/types/library'

type SortKey = 'title' | 'album' | 'genre' | 'year' | 'playCount' | 'format' | 'duration' | 'rating'

const PAGE_SIZE = 100
// See the v-virtual-scroll template comment (above the v-else-if="virtualizeSongs"
// branch) for why this exists and why it mirrors QueueDrawer.vue's own
// QUEUE_VIRTUALIZE_THRESHOLD.
const SONG_VIRTUALIZE_THRESHOLD = 500
// See showAlphabetBar's own comment — matches AlbumsView/ArtistsView's
// PAGE_SIZE (60), a reasonable "more screens than you'd want to scroll by
// hand" cutoff for 48px-tall rows too.
const ALPHABET_BAR_MIN_SONGS = 60

export default {
  name: 'SongTable',
  components: { SongRow, SongTableHeader, AlphabetIndexBar, InfiniteScrollTrigger },
  props: {
    // Pass the complete list this view has (not a pre-sliced page) —
    // sorting and render-slicing (visibleSongs/virtualizeSongs) both happen
    // inside this component, in that order, so a column sort always spans
    // everything given here, and scrolling only ever grows/virtualizes how
    // much of the (already sorted) result is rendered.
    songs: {
      type: Array as () => Song[],
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
    // song-number/playlist order is what actually plays, not an
    // alphabetical-by-title reshuffle. ArtistDetailView's/HomeView's "most
    // played" shelves instead pass 'playCount' (server-sorted desc).
    // Everywhere else without an override defaults to title, so a plain
    // library browse isn't just "whatever order the API happened to
    // return".
    defaultSortKey: { type: String as PropType<SortKey | null>, default: 'title' },
    defaultSortDirection: { type: String as () => 'asc' | 'desc', default: 'asc' },
    // Whether clicking a song queues the rest of this list too (true,
    // default) or just that one song (false). Set to false for raw
    // library-browse views whose list isn't a curated sequence and can run
    // into the thousands (SongsView, GenreDetailView) — everywhere else
    // (album/playlist/artist detail, favorites, search, home shelves) is a
    // bounded, intentional list, so playing through it is the expected
    // behavior, same as any other music player.
    queueWholeList: { type: Boolean, default: true },
    // Renders placeholder rows matching SongRow's column layout instead of
    // the real (still-loading) songs — avoids the height jump of swapping
    // a spinner for a full table once data arrives.
    loading: { type: Boolean, default: false },
    // Pins the column-label row so it stays visible while scrolling through
    // a long list, right below whatever the page's own sticky title/filter
    // block is (its height is passed in via the --sticky-header-offset CSS
    // var, set on this component's root — see SongsView.vue). Off by
    // default since it only makes sense for pages that actually have a
    // sticky block above the list (currently just SongsView).
    stickyHeader: { type: Boolean, default: false },
    // Album detail's own opt-in — groups rows under a "Disc N" header per
    // distinct discNumber instead of one flat sequence. Only actually
    // takes effect while sorted in natural order (see showDiscGroups) and
    // when the songs given actually span more than one disc — a
    // single-disc album (the common case) doesn't grow a redundant "Disc
    // 1" heading. Not the default for every SongTable consumer since
    // grouping by disc only means anything for a single album's own
    // songs — a playlist/search/queue list can mix songs from many
    // different albums, where "disc number" isn't a meaningful grouping.
    groupByDisc: { type: Boolean, default: false },
    // Playlist detail's own opt-in — rows become draggable and a drop
    // emits `reorder`. Only ever honoured while the list is in its natural
    // order (see canReorder): with a column sort active, a row's position
    // on screen has nothing to do with its position in the playlist, so
    // dropping it "between two rows" couldn't mean anything.
    reorderable: { type: Boolean, default: false },
  },
  emits: ['reorder'],
  data() {
    return {
      sortKey: this.defaultSortKey as SortKey | null,
      sortDirection: this.defaultSortDirection as 'asc' | 'desc',
      visibleCount: PAGE_SIZE,
      // Set by onSort() the moment the user picks a column themselves —
      // from then on the defaultSortKey watcher below must leave sortKey
      // alone. Without this, sorting a still-loading SongsView by
      // anything other than the eventual default (e.g. clicking "Album"
      // while fetchAllSongs() is still streaming in pages) got silently
      // discarded the instant loading finished and defaultSortKey flipped
      // from null to 'title' — the view snapped back to title-sort with
      // no visible cause, looking like "sorting only ever covered
      // whatever had loaded so far".
      userChangedSort: false,
      // Guards toggleStar() against a rapid double-click flipping the same
      // song twice concurrently, which (since both calls read `starred`
      // before either resolves) can leave the local state one flip behind
      // what the server actually recorded.
      starringSongIds: new Set<string>(),
      // Row positions (index within sortedSongs), not song ids — a song
      // can appear more than once in the same list (e.g. a playlist with a
      // song added twice), and an id-keyed Set would make toggling one
      // occurrence's checkbox also mark every other row sharing that id as
      // selected. See selectedSongs for resolving these back to real
      // Song objects when a bulk action needs them.
      selectedRowKeys: new Set<number>(),
      createPlaylistDialog: false,
      createPlaylistName: '',
      // Set by openCreatePlaylistDialog() — the song(s) (selection-aware,
      // same as addToPlaylist()) to seed the new playlist with once
      // confirmCreatePlaylist() actually creates it.
      createPlaylistSongs: [] as Song[],
      // Drag state for a reorderable list — same three fields (and the
      // same before/after boundary handling) as QueueDrawer.vue's own
      // drag-to-reorder, since the interaction is identical.
      dragIndex: null as number | null,
      dragOverIndex: null as number | null,
      dragOverHalf: null as 'before' | 'after' | null,
    }
  },
  computed: {
    skeletonRowCount(): number {
      return Math.min(this.songs.length || 8, 8)
    },
    playbackStore() {
      return usePlaybackStore()
    },
    libraryStore() {
      return useLibraryStore()
    },
    // Selecting even one row switches every row into "selection mode" (see
    // SongRow.vue's own selectionMode prop) — showing every checkbox, not
    // just the currently-hovered row's, so the rest of a multi-song
    // selection can be built up without hunting for each row individually.
    selectionMode(): boolean {
      return this.selectedRowKeys.size > 0
    },
    // Resolved in list order (not selection order) so "Add to Queue"
    // queues songs the same way clicking through the list would.
    selectedSongs(): Song[] {
      return this.sortedSongs.filter((_song, index) => this.selectedRowKeys.has(index))
    },
    // A column sort reorders what's on screen without touching the
    // playlist itself, so dragging a row while one is active would be
    // rearranging a view, not the list — the drag is simply unavailable
    // until the sort is cleared again (which, in a reorderable list, is
    // what a third click on the same column does — see onSort()).
    canReorder(): boolean {
      return this.reorderable && !this.sortKey
    },
    sortedSongs(): Song[] {
      if (!this.sortKey) return this.songs
      const key = this.sortKey
      const dir = this.sortDirection === 'desc' ? -1 : 1
      return [...this.songs].sort((a, b) => {
        const av = this.sortValue(a, key)
        const bv = this.sortValue(b, key)
        if (av < bv) return -1 * dir
        if (av > bv) return 1 * dir
        return 0
      })
    },
    // Every SongTable list now renders the same "grow on scroll" way (see
    // visibleSongs) instead of the old per-caller pagination/disablePagination
    // split, so this can fire for any of them — a big genre, a huge starred/
    // search result set, a long playlist, not just SongsView's full catalog.
    virtualizeSongs(): boolean {
      return this.sortedSongs.length > SONG_VIRTUALIZE_THRESHOLD
    },
    // No more page-number nav or a disablePagination escape hatch — every
    // caller gets the same incrementally-growing slice, with
    // infinite-scroll-trigger (below) revealing more as it's scrolled to.
    // PAGE_SIZE (100) already covers virtually every bounded list this
    // renders (an album, a playlist, a single genre) in one go, so this
    // reads as "show everything" there and only actually paces the load for
    // the few genuinely huge lists — and past SONG_VIRTUALIZE_THRESHOLD,
    // virtualizeSongs takes over rendering instead of this.
    visibleSongs(): Song[] {
      return this.sortedSongs.slice(0, this.visibleCount)
    },
    // Grouping only makes visual sense in the songs' own natural order —
    // sorting by title/duration/etc. would otherwise scatter one disc's
    // rows across several disconnected "Disc N" sections.
    showDiscGroups(): boolean {
      return this.groupByDisc && !this.sortKey && this.discGroups.length > 1
    },
    discGroups(): { discNumber: number; rows: { song: Song; index: number }[] }[] {
      const groups = new Map<number, { song: Song; index: number }[]>()
      this.visibleSongs.forEach((song, index) => {
        const disc = song.discNumber ?? 1
        const rows = groups.get(disc) ?? []
        rows.push({ song, index })
        groups.set(disc, rows)
      })
      return [...groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([discNumber, rows]) => ({ discNumber, rows }))
    },
    letterFirstIndex(): Map<string, number> {
      return firstIndexByLetter(this.sortedSongs, (song) => song.title)
    },
    availableLetters(): Set<string> {
      return new Set(this.letterFirstIndex.keys())
    },
    // Alphabet jump only makes sense while the list is actually sorted
    // alphabetically by title — not natural/disc order (album, playlist
    // detail), not playCount (Home/Artist detail's "top songs" shelves) —
    // and only once scrolling by hand would actually be a chore. A small
    // shelf or a single album's tracklist never needs it, even if it
    // happens to be title-sorted; ALPHABET_BAR_MIN_SONGS is that cutoff.
    showAlphabetBar(): boolean {
      return this.sortKey === 'title' && this.sortedSongs.length >= ALPHABET_BAR_MIN_SONGS
    },
  },
  watch: {
    // A new song list (different filter, different album, ...) or a new
    // sort both invalidate which page was open / how much was revealed —
    // and, since selectedRowKeys is keyed by position within sortedSongs
    // (see its own comment), also invalidate any existing selection: the
    // same indices would now silently point at different songs.
    songs() {
      this.visibleCount = PAGE_SIZE
      this.clearSelection()
    },
    sortKey() {
      this.visibleCount = PAGE_SIZE
      this.clearSelection()
    },
    sortDirection() {
      this.clearSelection()
    },
    // Lets a caller change the *effective* default after mount — used by
    // SongsView to keep the list in stable arrival order (sortKey null,
    // new songs only ever append) while its background-paginated fetch is
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
  mounted() {
    window.addEventListener('keydown', this.onKeydown)
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKeydown)
  },
  methods: {
    // Escape clears a multi-selection — the only way to back out of one
    // now that the old floating selection bar (Play Next/Add to Queue,
    // already duplicating what a selected row's own "..." menu does via
    // selectedOrSingle, plus a close button) was removed as redundant.
    // Skipped while the create-playlist dialog is open so Escape closes
    // that (Vuetify's own default dialog behavior) instead of also
    // silently clearing the selection underneath it.
    onKeydown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !this.selectionMode || this.createPlaylistDialog) return
      this.clearSelection()
    },
    loadMoreVisible() {
      this.visibleCount += PAGE_SIZE
    },
    jumpToLetter(letter: string) {
      const index = this.letterFirstIndex.get(letter)
      if (index === undefined) return
      if (this.virtualizeSongs) {
        const virtualScroll = this.$refs.virtualScroll as
          { scrollToIndex: (i: number) => void } | undefined
        virtualScroll?.scrollToIndex(index)
        return
      }
      // Plain-list path: make sure the target row is actually rendered
      // before trying to scroll to it — jumping to a letter past
      // visibleCount's current slice would otherwise reach for a row that
      // doesn't exist in the DOM yet.
      if (index >= this.visibleCount) {
        this.visibleCount = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE
      }
      this.$nextTick(() => {
        document.querySelector(`[data-song-index="${index}"]`)?.scrollIntoView({ block: 'center' })
      })
    },
    sortValue(song: Song, key: SortKey): string | number {
      // Format has no single natural sort order of its own — bitrate is the
      // meaningful "quality" ranking underneath that column.
      if (key === 'format') return song.bitRate ?? 0
      const value = song[key]
      if (typeof value === 'string') return value.toLowerCase()
      return value ?? 0
    },
    // The drag/drop half below mirrors QueueDrawer.vue's, including the
    // original-index vs. post-removal-index conversion — see its own
    // comments for why the two differ.
    dragOverPosition(index: number): 'before' | 'after' | null {
      return this.dragOverIndex === index ? this.dragOverHalf : null
    },
    insertBeforeIndex(index: number, event: DragEvent): number {
      const row = event.currentTarget as HTMLElement
      const rect = row.getBoundingClientRect()
      const isBottomHalf = event.clientY > rect.top + rect.height / 2
      return isBottomHalf ? index + 1 : index
    },
    dropIndex(index: number, event: DragEvent): number {
      const insertBefore = this.insertBeforeIndex(index, event)
      return insertBefore > (this.dragIndex ?? 0) ? insertBefore - 1 : insertBefore
    },
    onRowDragStart(index: number) {
      this.dragIndex = index
    },
    onRowDragOver({ index, event }: { index: number; event: DragEvent }) {
      if (index === this.dragIndex) {
        // No indicator on the row being dragged itself — dropping a song
        // onto its own position changes nothing.
        this.dragOverIndex = null
        this.dragOverHalf = null
        return
      }
      this.dragOverIndex = index
      this.dragOverHalf = this.insertBeforeIndex(index, event) > index ? 'after' : 'before'
    },
    onRowDragLeave(index: number) {
      if (this.dragOverIndex === index) {
        this.dragOverIndex = null
        this.dragOverHalf = null
      }
    },
    onRowDrop({ index, event }: { index: number; event: DragEvent }) {
      const from = this.dragIndex
      // Read before clearing: dropIndex() works off dragIndex to convert
      // the drop boundary into a post-removal position.
      const to = from === null ? null : this.dropIndex(index, event)
      this.clearDragState()
      if (from === null || to === null) return
      if (to === from) return
      // The owning view persists this and owns the songs array — with a
      // column sort impossible here (see canReorder), both indices are
      // positions in the list it passed in.
      this.$emit('reorder', { from, to })
    },
    onRowDragEnd() {
      this.clearDragState()
    },
    clearDragState() {
      this.dragIndex = null
      this.dragOverIndex = null
      this.dragOverHalf = null
    },
    onSort(key: SortKey) {
      this.userChangedSort = true
      if (this.sortKey === key) {
        // A third click drops back to the list's own order, but only where
        // that order means something the user can act on: in a reorderable
        // list it's the playlist itself, and it's also the only way back
        // to being able to drag rows at all (see canReorder). Everywhere
        // else "unsorted" is just whatever the API happened to return, so
        // those keep cycling asc/desc as before.
        if (this.reorderable && this.sortDirection === 'desc') {
          this.sortKey = null
          return
        }
        this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc'
      } else {
        this.sortKey = key
        this.sortDirection = 'asc'
      }
    },
    playSong(song: Song, index: number | null) {
      // Multi-selection: replace the queue with just the selected songs (in
      // list order, same as selectedSongs) and start the first one, instead
      // of either of the branches below - same "act on the whole selection"
      // convention as playNextSong/addToQueue/addToPlaylist
      // (selectedOrSingle), and takes priority over queueWholeList since a
      // deliberate multi-song pick isn't "just browsing" either way.
      // pinFirst: false - this is "play the whole selection", not one
      // specific song the user picked as the start (same reasoning as
      // PlaylistDetailView.vue's playAll()).
      if (this.selectionMode && index != null && this.selectedRowKeys.has(index)) {
        // peek: replaces the queue with more than one song whenever more
        // than one is actually selected — see peekQueueDrawer()'s own
        // comment for the rule.
        void this.playbackStore.playSongList(
          this.selectedSongs,
          0,
          false,
          this.selectedSongs.length > 1,
        )
        return
      }
      if (!this.queueWholeList) {
        // Raw library browsing (Songs/Genre views) — not a curated
        // sequence, so only the clicked song goes into the queue, not the
        // rest of a list that can run into the thousands. Use the context
        // menu's "Play next" to queue more, or "Song Radio" to build a
        // queue out of similar songs.
        void this.playbackStore.playSongList([song], 0)
        return
      }
      // A curated, bounded list (album/playlist/favorites/search/...) —
      // clicking a song plays it and continues through the rest, same as
      // any other music player. Uses the row's own absolute index (passed
      // through from SongRow) rather than re-deriving it by id — a
      // findIndex-by-id would always resolve to the *first* occurrence,
      // playing the wrong position when the same song appears twice in
      // one list (e.g. concatenated from two playlists).
      const position = index ?? this.sortedSongs.findIndex((t) => t.id === song.id)
      // peek: replaces the queue with the whole list, even though only the
      // clicked position starts playing immediately — see
      // peekQueueDrawer()'s own comment for the rule.
      void this.playbackStore.playSongList(
        this.sortedSongs,
        Math.max(0, position),
        true,
        this.sortedSongs.length > 1,
      )
    },
    playNextSong(song: Song, index?: number) {
      this.playbackStore.queueNext(this.selectedOrSingle(song, index))
    },
    async startSongRadio(song: Song) {
      try {
        await this.playbackStore.startSongRadio(song)
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('library.songRadio'),
          message: this.$t('library.songRadioError'),
        })
        console.error('[song-radio]', error)
      }
    },
    async toggleStar(song: Song) {
      if (this.starringSongIds.has(song.id)) return
      this.starringSongIds.add(song.id)
      const wasStarred = song.starred
      try {
        await this.libraryStore.toggleStar({ id: song.id, starred: wasStarred })
        song.starred = !wasStarred
      } finally {
        this.starringSongIds.delete(song.id)
      }
    },
    async setRating({ song, rating }: { song: Song; rating: number }) {
      const previous = song.rating
      song.rating = rating
      try {
        await this.libraryStore.setRating(song.id, rating)
      } catch (error) {
        song.rating = previous
        console.error('[song-table] Failed to set rating:', error)
      }
    },
    addToQueue(song: Song, index?: number) {
      this.playbackStore.addToQueue(this.selectedOrSingle(song, index))
    },
    async addToPlaylist({
      song,
      playlistId,
      index,
    }: {
      song: Song
      playlistId: string
      index?: number
    }) {
      const songs = this.selectedOrSingle(song, index)
      await this.libraryStore.addToPlaylist(
        playlistId,
        songs.map((t) => t.id),
      )
    },
    openCreatePlaylistDialog({ song, index }: { song: Song; index?: number }) {
      this.createPlaylistSongs = this.selectedOrSingle(song, index)
      this.createPlaylistName = ''
      this.createPlaylistDialog = true
    },
    async confirmCreatePlaylist() {
      if (!this.createPlaylistName.trim()) return
      try {
        await this.libraryStore.createPlaylist(
          this.createPlaylistName,
          this.createPlaylistSongs.map((t) => t.id),
        )
        this.createPlaylistDialog = false
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('playlists.createTitle'),
          message: error instanceof Error ? error.message : String(error),
        })
        console.error('[song-table] Failed to create playlist:', error)
      }
    },
    // A row's own actions (play-next/add-to-queue/add-to-playlist, all via
    // SongRow.vue's "..." menu) apply to the *whole* current selection
    // once the row they were triggered from is part of one — the same
    // "act on the selection, not just what you clicked" convention as a
    // file manager's right-click menu. Acting on a row that isn't
    // selected (or when nothing's selected at all) still just means that
    // one song, same as before multiselect existed.
    selectedOrSingle(song: Song, index?: number): Song[] {
      return this.selectionMode && index != null && this.selectedRowKeys.has(index)
        ? this.selectedSongs
        : [song]
    },
    toggleSelect(_song: Song, index: number) {
      if (this.selectedRowKeys.has(index)) {
        this.selectedRowKeys.delete(index)
      } else {
        this.selectedRowKeys.add(index)
        // Same "fetch eagerly once selection starts" reasoning as
        // SongRow's own openMenu() — the playlist submenu below shouldn't
        // open empty on the very first use just because nothing had
        // fetched it yet.
        if (this.libraryStore.playlists.length === 0) {
          void this.libraryStore.fetchPlaylists()
        }
      }
    },
    clearSelection() {
      this.selectedRowKeys.clear()
    },
  },
}
</script>

<style scoped>
/* Keeps the rightmost column (song-actions) clear of AlphabetIndexBar's own
 * fixed position (right: 6px + its own ~26px width, see its stylesheet) —
 * only applied while the bar actually renders, so every other SongTable
 * consumer keeps using the full width it always had. */
.song-table--with-alphabet-bar {
  margin-right: 40px;
}

/* Column widths/flex mirror SongRow.vue's so a skeleton row lines up with
 * the real rows that replace it once loading finishes. */
.song-row {
  gap: 12px;
}

.song-index {
  flex: 0 0 44px;
}

.song-cover {
  flex: 0 0 auto;
}

.song-title {
  flex: 3 1 160px;
}

.song-album {
  flex: 2 1 120px;
  min-width: 0;
}

.song-genre {
  flex: 1.5 1 90px;
  min-width: 0;
}

.song-year,
.song-playcount,
.song-format,
.song-duration {
  flex: 0 0 44px;
}

.song-format {
  flex-basis: 120px;
}

.song-actions {
  flex: 0 0 200px;
}

.disc-header {
  padding: 12px 8px 4px;
  font-weight: 600;
}

/* v-skeleton-loader's "image"/"text" bones ignore the component's own
 * width/height props (fixed CSS height + a 16px margin baked in) — those
 * props only size the outer wrapper. Forcing the bone to fill that wrapper
 * exactly is what makes each skeleton cell match SongRow.vue's real
 * dimensions (40px cover, 20px text lines) pixel for pixel, so the row
 * height (48px, py-1 + the 40px cover/title-block) never shifts once real
 * rows render in. */
.song-row--skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}

.min-width-0 {
  min-width: 0;
}

/* Pins the column-label row right below the page's own sticky title/filter
 * block — --sticky-header-offset is set on this component's root by the
 * consuming view (see SongsView.vue), and --v-layout-top is Vuetify's own
 * app-bar-height variable, so this stays correct regardless of app-bar
 * density or how tall the filter block above it happens to be. :deep()
 * because the sticky class lands on SongTableHeader's own root element,
 * outside this component's own scoped template. */
:deep(.song-table-header--sticky) {
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
</style>
