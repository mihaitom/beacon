<template>
  <form class="mobile-top-bar-search" role="search" @submit.prevent="submit">
    <v-text-field
      ref="inputEl"
      v-model="query"
      :placeholder="$t('search.label')"
      :aria-label="$t('search.label')"
      prepend-inner-icon="mdi-magnify"
      variant="solo-filled"
      density="compact"
      rounded="pill"
      flat
      hide-details
      clearable
      enterkeyhint="search"
      class="mobile-top-bar-search__field"
    />
  </form>
</template>

<script lang="ts">
const LIVE_DELAY_MS = 250

let liveTimer: ReturnType<typeof setTimeout> | undefined

/** The phone's version of the desktop's TopBarSearch.vue: always a field,
 * searching everything at once on /m/search. Elsewhere it waits for the
 * keyboard's search key, so typing does not pull the page away; on the
 * results page itself the results follow as you type. */
export default {
  name: 'MobileTopBarSearch',
  data() {
    return { query: '' as string | null }
  },
  computed: {
    onSearchPage(): boolean {
      return this.$route.name === 'm-search'
    },
  },
  watch: {
    onSearchPage: {
      immediate: true,
      handler(onSearch: boolean) {
        // Picks up a term that came another way (back, a link) on the way
        // in, and lets go of it on the way out.
        const q = this.$route.query?.q
        this.query = onSearch && typeof q === 'string' ? q : ''
      },
    },
    query(value: string | null) {
      if (!this.onSearchPage) return
      clearTimeout(liveTimer)
      liveTimer = setTimeout(() => this.showResults(value ?? '', 'replace'), LIVE_DELAY_MS)
    },
  },
  beforeUnmount() {
    clearTimeout(liveTimer)
  },
  methods: {
    submit() {
      clearTimeout(liveTimer)
      const value = (this.query ?? '').trim()
      if (!value) return
      this.showResults(value, this.onSearchPage ? 'replace' : 'push')
      // Closes the keyboard so the results are in sight.
      const input = this.$refs.inputEl as { blur?: () => void } | undefined
      input?.blur?.()
    },
    /** replace() while on the page: every pause in typing would otherwise
     * be a step to walk back through. */
    showResults(value: string, how: 'push' | 'replace') {
      const term = value.trim()
      if (this.$route.query?.q === term || (!term && !this.$route.query?.q)) return
      const to = { name: 'm-search', query: term ? { q: term } : {} }
      void (how === 'push' ? this.$router.push(to) : this.$router.replace(to))
    },
  },
}
</script>

<style scoped>
.mobile-top-bar-search {
  flex: 1;
  min-width: 0;
  margin-inline-end: 8px;
}

.mobile-top-bar-search__field :deep(.v-field) {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.mobile-top-bar-search__field :deep(.v-field--focused) {
  background: rgba(var(--v-theme-on-surface), 0.1);
}
</style>
