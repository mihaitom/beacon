import { defineComponent } from 'vue'
import { useAuthStore } from '@/stores/auth'
import {
  defaultDirection,
  filterFieldsFor,
  loadSongSort,
  saveSongSort,
  sortKeysFor,
  sortLabelKey,
  type SongFilterFieldDef,
  type SongSort,
  type SongSortKey,
} from '@/services/library/songBrowse'
import type { FilterField, LibraryFilters } from '@/services/library/libraryFilter'
import { readBooleanPreference, writeBooleanPreference } from '@/services/booleanPreference'

/** Tiles or rows, remembered across visits like the album list's toggle. */
const GRID_VIEW_KEY = 'beacon.songsGridView'

let debounceTimer: ReturnType<typeof setTimeout> | undefined

/** The search, sort and filter state of a page that lists songs to browse
 * (Songs, a genre). The page owns the list; this owns how it is narrowed
 * and put in order, so the two pages cannot drift apart. */
export const songBrowsingMixin = defineComponent({
  data() {
    return {
      filterQuery: '' as string | null,
      // What the list is searched by, a beat behind filterQuery: ranking
      // tens of thousands of songs on every keystroke would hold up the
      // very render that shows the character just typed.
      debouncedQuery: '',
      sort: loadSongSort(),
      // While a search is typed, the results come ranked by match and the
      // menu says so, until another order is picked.
      byRelevance: false,
      // Set once an order is picked - from then on it applies even while
      // the list is still arriving (see tableSort).
      sortPicked: false,
      filters: {} as LibraryFilters,
      gridView: readBooleanPreference(GRID_VIEW_KEY),
      /** Fields a page has no use for: every song of a genre has the same
       * genre. */
      excludedFilterFields: [] as FilterField[],
    }
  },
  computed: {
    browsingAuth() {
      return useAuthStore()
    },
    filterFields(): SongFilterFieldDef[] {
      const rated = this.browsingAuth.capabilities.personalRating
      return filterFieldsFor(this.browsingAuth.serverType).filter(
        (def) =>
          (def.field !== 'rating' || rated) && !this.excludedFilterFields.includes(def.field),
      )
    },
    sortKeys(): SongSortKey[] {
      return sortKeysFor(this.browsingAuth.serverType).filter(
        (key) =>
          (key !== 'rating' || this.browsingAuth.capabilities.personalRating) &&
          !this.excludedFilterFields.includes(key as FilterField),
      )
    },
    sortValue(): string {
      return this.byRelevance ? 'relevance' : this.sort.key
    },
    sortItems(): { title: string; value: string }[] {
      const items = this.sortKeys.map((key): { title: string; value: string } => ({
        title: this.$t(sortLabelKey(key)),
        value: key,
      }))
      if (this.debouncedQuery.trim()) {
        items.unshift({ title: this.$t('library.songSort.relevance'), value: 'relevance' })
      }
      return items
    },
    /** Null keeps the list as handed over: ranked by match while a search
     * is on, and in arrival order while a page's list is still streaming
     * in (see listComplete), so rows already on screen are not reshuffled
     * by every page that arrives. */
    tableSort(): SongSort | null {
      if (this.byRelevance) return null
      if (!this.listComplete() && !this.sortPicked) return null
      return this.sort
    },
  },
  watch: {
    filterQuery(value: string | null) {
      clearTimeout(debounceTimer)
      // clearable's clear button sets the model to null, not ''.
      debounceTimer = setTimeout(() => {
        this.debouncedQuery = value ?? ''
      }, 200)
    },
    debouncedQuery(query: string, previous: string) {
      const searching = Boolean(query.trim())
      if (searching !== Boolean(previous.trim())) this.byRelevance = searching
    },
  },
  created() {
    // An order saved on a server that has data for it, kept on one that has none.
    if (!this.sortKeys.includes(this.sort.key)) this.sort = { key: 'title', direction: 'asc' }
  },
  methods: {
    /** Overridden by a page whose list arrives in pages (Songs). */
    listComplete(): boolean {
      return true
    },
    pickSort(value: string) {
      if (value === 'relevance') {
        this.byRelevance = true
        return
      }
      const key = value as SongSortKey
      this.applySort({ key, direction: defaultDirection(key) })
    },
    toggleDirection() {
      this.applySort({
        key: this.sort.key,
        direction: this.sort.direction === 'asc' ? 'desc' : 'asc',
      })
    },
    setGridView(grid: boolean) {
      this.gridView = grid
      writeBooleanPreference(GRID_VIEW_KEY, grid)
      // The same offset lands somewhere else entirely in the other layout.
      window.scrollTo({ top: 0 })
    },
    applySort(sort: SongSort) {
      this.byRelevance = false
      this.sortPicked = true
      this.sort = sort
      saveSongSort(sort)
    },
  },
})
