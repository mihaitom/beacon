<template>
  <div class="top-bar-search" :class="{ 'top-bar-search--expanded': expanded }">
    <v-btn v-if="!expanded" icon="mdi-magnify" :title="$t('search.label')" @click="expand" />
    <form v-else class="top-bar-search__form" @submit.prevent="submit">
      <v-text-field
        ref="inputEl"
        v-model="query"
        :placeholder="$t('search.label')"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        hide-details
        clearable
        autofocus
        class="top-bar-search__field"
        @keydown.esc="onEscape"
        @blur="onBlur"
      />
    </form>
  </div>
</template>

<script lang="ts">
import { nextTick } from 'vue'

// Icon by default — only expands into an actual text field once clicked,
// and only navigates to /search (the real results page, with its own
// always-visible field and live-as-you-type results — see SearchView.vue)
// once submitted. Typing here doesn't search live or navigate anywhere by
// itself; this is just a compact entry point for the app bar, not a second
// copy of the results page's own search behavior.
//
// Stays expanded for as long as the search results page itself is active
// (see the onSearchPage watcher) — leaving it open there means a follow-up
// search doesn't need the icon clicked again first, and losing focus
// (onBlur) doesn't collapse it either while that page is what's showing.
export default {
  name: 'TopBarSearch',
  data() {
    return {
      expanded: false,
      query: '',
    }
  },
  computed: {
    onSearchPage(): boolean {
      return this.$route.name === 'search'
    },
  },
  watch: {
    onSearchPage: {
      immediate: true,
      handler(onSearch: boolean) {
        if (onSearch) {
          this.expanded = true
          // Only on the way in (this fires once per non-search -> search
          // transition, not on every query change afterwards) — picks up
          // a query that arrived some other way than this field itself
          // (a bookmark, browser back/forward, a link elsewhere) instead
          // of showing an empty box while results for something are
          // already on screen. Once here, further edits are the user's
          // own and this must not overwrite them again.
          const q = this.$route.query.q
          this.query = typeof q === 'string' ? q : ''
        } else {
          this.expanded = false
          this.query = ''
        }
      },
    },
  },
  methods: {
    async expand() {
      this.expanded = true
      // `autofocus` on the field (below) covers this in the common case,
      // but explicitly focusing once the DOM actually has it is a
      // guaranteed fallback rather than depending on the browser's
      // autofocus-on-dynamic-insertion behavior alone.
      await nextTick()
      const input = this.$refs.inputEl as { focus?: () => void } | undefined
      input?.focus?.()
    },
    // Collapses back to just the icon — losing focus without submitting
    // (or Escape) discards a half-typed, never-searched query rather than
    // leaving it sitting open in the app bar. Not used at all while
    // onSearchPage is true (see onBlur/onEscape below): the field stays
    // open there regardless of focus.
    collapse() {
      this.expanded = false
      this.query = ''
    },
    onBlur() {
      if (!this.onSearchPage) this.collapse()
    },
    onEscape() {
      if (this.onSearchPage) {
        // Still on the results page afterwards — just release focus
        // instead of hiding the field entirely, so it's still right
        // there (unfocused) for the next search.
        const input = this.$refs.inputEl as { blur?: () => void } | undefined
        input?.blur?.()
      } else {
        this.collapse()
      }
    },
    submit() {
      const value = this.query.trim()
      if (!value) return
      this.$router.push({ path: '/search', query: { q: value } })
    },
  },
}
</script>

<style scoped>
.top-bar-search {
  display: flex;
  align-items: center;
}

.top-bar-search__form {
  /* Grows from the collapsed icon button's own width — the width
   * transition (not a v-if crossfade) is what reads as the field
   * animating out of the icon instead of just popping in. */
  width: 40px;
  animation: top-bar-search-grow 0.25s ease forwards;
}

@keyframes top-bar-search-grow {
  from {
    width: 40px;
  }
  to {
    width: 280px;
  }
}

.top-bar-search__field {
  width: 100%;
}

@media (prefers-reduced-motion: reduce) {
  .top-bar-search__form {
    animation: none;
    width: 280px;
  }
}
</style>
