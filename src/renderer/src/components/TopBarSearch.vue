<template>
  <form class="top-bar-search" role="search" @submit.prevent="submit">
    <v-text-field
      ref="inputEl"
      v-model="query"
      :placeholder="$t('search.label')"
      prepend-inner-icon="mdi-magnify"
      variant="solo-filled"
      density="compact"
      rounded="pill"
      flat
      hide-details
      clearable
      class="top-bar-search__field"
      @focus="focused = true"
      @blur="focused = false"
      @keydown.esc="onEscape"
    >
      <template #append-inner>
        <!-- The way back here without the mouse; hidden once the field is
         - in use, where it would only crowd what is being typed. -->
        <kbd v-if="!focused && !query" class="top-bar-search__hint" aria-hidden="true">
          {{ shortcutHint }}
        </kbd>
        <exact-match-switch class="top-bar-search__exact" />
      </template>
    </v-text-field>
  </form>
</template>

<script lang="ts">
import { emitter } from '@/emitter'
import ExactMatchSwitch from '@/components/library/ExactMatchSwitch.vue'

// Always a field, not an icon that turns into one: search is the most used
// way into a library this size, and a bare magnifier in an otherwise empty
// bar read as decoration. Typing here doesn't search live or navigate by
// itself - it only goes to /search (the real results page, with its own
// live-as-you-type results, see SearchView.vue) once submitted.
export default {
  name: 'TopBarSearch',
  components: { ExactMatchSwitch },
  data() {
    return {
      query: '',
      focused: false,
    }
  },
  computed: {
    onSearchPage(): boolean {
      return this.$route.name === 'search'
    },
    shortcutHint(): string {
      return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
    },
  },
  watch: {
    onSearchPage: {
      immediate: true,
      handler(onSearch: boolean) {
        if (onSearch) {
          // Only on the way in (this fires once per non-search -> search
          // transition, not on every query change afterwards) - picks up
          // a query that arrived some other way than this field itself
          // (a bookmark, browser back/forward, a link elsewhere) instead
          // of showing an empty box while results for something are
          // already on screen. Once here, further edits are the user's
          // own and this must not overwrite them again.
          const q = this.$route.query.q
          this.query = typeof q === 'string' ? q : ''
        } else {
          this.query = ''
        }
      },
    },
  },
  mounted() {
    emitter.on('focusSearch', this.focus)
  },
  beforeUnmount() {
    emitter.off('focusSearch', this.focus)
  },
  methods: {
    focus() {
      const input = this.$refs.inputEl as { focus?: () => void } | undefined
      input?.focus?.()
    },
    // Releases focus so the keyboard shortcuts answer again. Off the results
    // page a half-typed, never-searched query goes with it; on the page it
    // stays, since it is what the results on screen are for.
    onEscape() {
      if (!this.onSearchPage) this.query = ''
      const input = this.$refs.inputEl as { blur?: () => void } | undefined
      input?.blur?.()
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
/* Takes what the bar can spare up to a comfortable reading width, and gives
 * way first when the window narrows. */
.top-bar-search {
  width: min(480px, 100%);
}

.top-bar-search__field :deep(.v-field) {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.top-bar-search__field :deep(.v-field--focused) {
  background: rgba(var(--v-theme-on-surface), 0.1);
}

.top-bar-search__exact {
  margin-left: 6px;
}

.top-bar-search__hint {
  font-family: inherit;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.16);
  color: rgba(var(--v-theme-on-surface), 0.5);
  white-space: nowrap;
}
</style>
