<template>
  <v-dialog v-model="visible" max-width="1080" :fullscreen="compact" scrollable>
    <v-card
      class="help-dialog"
      :class="{ 'help-dialog--compact': compact, 'help-dialog--nav-open': navOpen }"
      @keydown="onKeydown"
    >
      <header class="help-dialog__header">
        <v-btn
          v-if="history.length"
          icon="mdi-arrow-left"
          variant="text"
          size="small"
          :aria-label="$t('help.back')"
          :title="$t('help.back')"
          @click="back"
        />
        <v-card-title class="help-dialog__title">{{ $t('help.title') }}</v-card-title>
        <v-btn
          v-if="compact"
          :icon="navOpen ? 'mdi-text-box-outline' : 'mdi-format-list-bulleted'"
          variant="text"
          size="small"
          :aria-label="$t('help.contents')"
          :title="$t('help.contents')"
          :aria-pressed="navOpen"
          @click="navOpen = !navOpen"
        />
      </header>
      <v-divider />
      <div class="help-dialog__columns">
        <nav class="help-dialog__nav" :aria-label="$t('help.contents')">
          <v-text-field
            ref="search"
            v-model="query"
            prepend-inner-icon="mdi-magnify"
            :placeholder="$t('help.search')"
            :aria-label="$t('help.search')"
            variant="solo-filled"
            density="compact"
            flat
            hide-details
            clearable
            class="help-dialog__search"
            @keydown.down.prevent="focusResult(0)"
            @keydown.enter.prevent="openResult(results[0])"
          >
            <template v-if="!compact" #append-inner>
              <kbd class="help-dialog__kbd">{{ searchShortcut }}</kbd>
            </template>
          </v-text-field>
          <p v-if="$i18n.locale !== 'en'" class="help-dialog__note text-body-small">
            {{ $t('help.englishOnly') }}
          </p>

          <div v-if="searching" class="help-dialog__results">
            <p v-if="!results.length" class="help-dialog__empty text-body-medium">
              {{ $t('help.noResults') }}
            </p>
            <button
              v-for="(result, i) in results"
              :key="`${result.section.page}#${result.section.anchor}`"
              ref="result"
              type="button"
              class="help-dialog__result"
              @click="openResult(result)"
              @keydown.down.prevent="focusResult(i + 1)"
              @keydown.up.prevent="focusResult(i - 1)"
            >
              <span class="help-dialog__result-page text-body-small">
                {{ pageLabel(result.section.page) }}
              </span>
              <span class="help-dialog__result-heading text-body-medium">
                <template v-for="(run, j) in highlight(result.section.heading)" :key="j">
                  <mark v-if="run.hit">{{ run.text }}</mark>
                  <template v-else>{{ run.text }}</template>
                </template>
              </span>
              <span v-if="result.snippet" class="help-dialog__result-snippet text-body-small">
                <template v-for="(run, j) in highlight(result.snippet)" :key="j">
                  <mark v-if="run.hit">{{ run.text }}</mark>
                  <template v-else>{{ run.text }}</template>
                </template>
              </span>
            </button>
          </div>

          <v-list v-else density="compact" nav class="help-dialog__toc">
            <template v-for="group in groups" :key="group.title">
              <v-list-subheader>{{ group.title }}</v-list-subheader>
              <template v-for="page in group.pages" :key="page.id">
                <v-list-item
                  :active="page.id === pageId"
                  :title="pageTitle(page)"
                  color="primary"
                  @click="go(page.id)"
                />
                <template v-if="page.id === pageId">
                  <v-list-item
                    v-for="entry in contents"
                    :key="entry.anchor!"
                    :active="entry.anchor === activeAnchor"
                    :title="entry.heading"
                    color="primary"
                    class="help-dialog__toc-entry"
                    @click="go(page.id, entry.anchor)"
                  />
                </template>
              </template>
            </template>
          </v-list>
        </nav>

        <div ref="body" class="help-dialog__content" @scroll.passive="onScroll">
          <!-- eslint-disable-next-line vue/no-v-html -- our own docs/help/, rendered by markdown-it with html off, never user input -->
          <div class="beacon-markdown" @click="onContentClick" v-html="html" />
        </div>
      </div>
      <v-divider />
      <v-card-actions>
        <v-btn
          variant="text"
          :href="githubUrl"
          target="_blank"
          rel="noopener noreferrer"
          append-icon="mdi-open-in-new"
        >
          {{ $t('help.openOnGitHub') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { emitter } from '@/emitter'
import packageJson from '../../../../package.json'
import {
  FEATURES_PAGE,
  HELP_PAGES,
  findHelpPage,
  isFaqPage,
  pageFor,
  renderHelpPage,
  type HelpPage,
  type HelpTarget,
} from '@/services/help/docs'
import {
  highlightRuns,
  searchHelp,
  tableOfContents,
  type HelpSearchResult,
  type HelpSection,
  type HelpTextRun,
} from '@/services/help/search'

/** Shows `tab`'s panel and hides its siblings' - the tab groups
 * services/help/docs.ts renders into the page as plain HTML. */
function showTab(tab: HTMLElement): void {
  const group = tab.closest('.help-tabs')
  if (!group) return
  for (const other of group.querySelectorAll<HTMLElement>('[data-help-tab]')) {
    const selected = other === tab
    other.setAttribute('aria-selected', String(selected))
    const panel = group.querySelector<HTMLElement>(
      `[id="${CSS.escape(other.getAttribute('aria-controls') ?? '')}"]`,
    )
    if (panel) panel.hidden = !selected
  }
}

// How far below the top of the text a heading may sit and still count as
// the one being read - about a line, so a heading just scrolled to is it.
const SCROLL_SPY_OFFSET = 32
// How long a heading jumped to stays marked.
const FLASH_MS = 1600

interface Visit {
  page: string
  scrollTop: number
}

/** What Beacon can do heads the FAQ: it answers the first question anyone
 * has. */
function inFaq(page: HelpPage): boolean {
  return page === FEATURES_PAGE || isFaqPage(page)
}

/** The bundled docs (services/help/docs.ts), each opened from where its
 * question comes up and browsable from there: a search over all of them,
 * and the contents of the FAQ and the guides beside the page. */
export default {
  name: 'HelpDialog',
  props: {
    /** The phone shell: fullscreen, the contents in place of the page. */
    compact: { type: Boolean, default: false },
  },
  data() {
    return {
      visible: false,
      navOpen: false,
      pageId: pageFor('faq').id,
      query: '',
      activeAnchor: null as string | null,
      history: [] as Visit[],
      flashTimer: 0,
      listener: null as ((target: string | HelpTarget) => void) | null,
    }
  },
  computed: {
    page(): HelpPage {
      return findHelpPage(this.pageId)
    },
    groups(): { title: string; pages: HelpPage[] }[] {
      return [
        { title: this.$t('help.faq'), pages: [FEATURES_PAGE, ...HELP_PAGES.filter(isFaqPage)] },
        { title: this.$t('help.guides'), pages: HELP_PAGES.filter((page) => !inFaq(page)) },
      ]
    },
    contents(): HelpSection[] {
      return tableOfContents(this.page)
    },
    searching(): boolean {
      return !!this.query?.trim()
    },
    results(): HelpSearchResult[] {
      return this.searching ? searchHelp(this.query) : []
    },
    html(): string {
      return renderHelpPage(this.page)
    },
    githubUrl(): string {
      return `${packageJson.homepage}/blob/main/${this.page.path}`
    },
    searchShortcut(): string {
      return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
    },
  },
  watch: {
    pageId() {
      this.activeAnchor = null
    },
  },
  mounted() {
    this.listener = (target: string | HelpTarget) => this.open(target)
    emitter.on('openHelp', this.listener)
  },
  beforeUnmount() {
    if (this.listener) emitter.off('openHelp', this.listener)
    window.clearTimeout(this.flashTimer)
  },
  methods: {
    open(target: string | HelpTarget) {
      const anchor = typeof target === 'string' ? null : target.anchor
      this.history = []
      this.query = ''
      this.navOpen = false
      this.visible = true
      this.show(typeof target === 'string' ? pageFor(target).id : target.page, anchor)
    },
    /** Goes to a page from inside the dialog, so back returns here. */
    go(page: string, anchor: string | null = null) {
      const body = this.bodyEl()
      this.history.push({ page: this.pageId, scrollTop: body?.scrollTop ?? 0 })
      this.navOpen = false
      this.show(page, anchor)
    },
    back() {
      const visit = this.history.pop()
      if (!visit) return
      this.pageId = visit.page
      void this.$nextTick(() => {
        const body = this.bodyEl()
        if (body) body.scrollTop = visit.scrollTop
        this.onScroll()
      })
    },
    show(page: string, anchor: string | null) {
      this.pageId = page
      void this.scrollTo(anchor)
    },
    openResult(result: HelpSearchResult | undefined) {
      if (!result) return
      this.go(result.section.page, result.section.anchor)
    },
    focusResult(index: number) {
      const results = (this.$refs.result as HTMLElement[] | undefined) ?? []
      if (index < 0) {
        ;(this.$refs.search as { focus?: () => void } | undefined)?.focus?.()
        return
      }
      results[Math.min(index, results.length - 1)]?.focus()
    },
    highlight(text: string): HelpTextRun[] {
      return highlightRuns(text, this.query)
    },
    /** A FAQ topic says it is one, since its title alone ("Party mode")
     * can read like the guide of the same name. */
    pageLabel(id: string): string {
      const page = findHelpPage(id)
      return inFaq(page) ? `${this.$t('help.faq')} · ${this.pageTitle(page)}` : page.title
    },
    /** The README's heading ("Features") reads like a section of it, not
     * like the page it is here - so this one has a title of its own. */
    pageTitle(page: HelpPage): string {
      return page === FEATURES_PAGE ? this.$t('features.title') : page.title
    },
    onKeydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        this.navOpen = true
        ;(this.$refs.search as { focus?: () => void } | undefined)?.focus?.()
      }
    },
    bodyEl(): HTMLElement | undefined {
      return this.$refs.body as HTMLElement | undefined
    },
    /** The contents entry of the heading being read: the last main heading
     * at or above the top of the text. */
    onScroll() {
      const body = this.bodyEl()
      if (!body) return
      const top = body.getBoundingClientRect().top + SCROLL_SPY_OFFSET
      let active: string | null = null
      for (const entry of this.contents) {
        const heading = body.querySelector<HTMLElement>(`[id="${CSS.escape(entry.anchor!)}"]`)
        if (heading && heading.getBoundingClientRect().top <= top) active = entry.anchor
      }
      this.activeAnchor = active
    },
    /** Links between the bundled docs and within one stay in the dialog;
     * everything else was given target="_blank" when it was rendered. */
    onContentClick(event: MouseEvent) {
      const tab = (event.target as Element | null)?.closest<HTMLElement>('[data-help-tab]')
      if (tab) {
        showTab(tab)
        return
      }
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[data-help-page]')
      if (!link) return
      event.preventDefault()
      const page = link.dataset.helpPage!
      const anchor = link.dataset.helpAnchor || null
      if (page !== this.pageId) this.go(page, anchor)
      else void this.scrollTo(anchor)
    },
    async scrollTo(anchor: string | null) {
      await this.$nextTick()
      const body = this.bodyEl()
      if (!body) return
      const target = anchor ? body.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`) : null
      // A link to one of a tab group's setups, or to something inside one,
      // opens that tab first.
      const panel = target?.closest<HTMLElement>('.help-tabs__panel')
      const tab = target?.matches('[data-help-tab]')
        ? target
        : panel
          ? body.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(panel.id)}"]`)
          : null
      if (tab) showTab(tab)
      if (target) {
        target.scrollIntoView?.({ block: 'start' })
        this.flash(target)
      } else {
        body.scrollTop = 0
      }
      this.onScroll()
    },
    /** Marks the heading jumped to for a moment, so the eye finds it in a
     * page that moved under it. */
    flash(target: HTMLElement) {
      window.clearTimeout(this.flashTimer)
      for (const old of this.bodyEl()?.querySelectorAll('.help-flash') ?? []) {
        old.classList.remove('help-flash')
      }
      target.classList.add('help-flash')
      this.flashTimer = window.setTimeout(() => target.classList.remove('help-flash'), FLASH_MS)
    },
  },
}
</script>

<style scoped>
/* A fixed height rather than .beacon-dialog's cap: the contents and the page
 * scroll side by side, and a card that grew and shrank with each page would
 * move the contents under the pointer. Same 70vh, for the same reason. Set
 * as the flex basis: v-dialog gives its card `flex: 1 1 100%`, which wins
 * over a plain height and stretches it to the whole overlay. */
.help-dialog {
  display: flex;
  flex-direction: column;
  flex: 0 0 var(--beacon-dialog-max-height);
  height: var(--beacon-dialog-max-height);
  overflow: hidden;
}

.help-dialog--compact {
  flex: 1 1 100%;
  height: 100%;
  background: var(--beacon-chrome);
}

.help-dialog__header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 8px 8px;
}

.help-dialog__title {
  flex: 1;
  min-width: 0;
  padding-inline: 8px;
}

.help-dialog__columns {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* Two scroll regions side by side, not one inside the other: the contents
 * stay where they are while the page scrolls. */
.help-dialog__nav {
  display: flex;
  flex-direction: column;
  flex: 0 0 280px;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 8px 12px 12px;
  border-right: 1px solid var(--beacon-hairline);
}

.help-dialog__content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 8px 28px 24px;
}

/* The phone has no room for both: the contents replace the page while open. */
.help-dialog--compact .help-dialog__nav {
  display: none;
  flex-basis: auto;
  width: 100%;
  border-right: none;
}

.help-dialog--compact.help-dialog--nav-open .help-dialog__nav {
  display: flex;
}

.help-dialog--compact.help-dialog--nav-open .help-dialog__content {
  display: none;
}

.help-dialog--compact .help-dialog__content {
  padding: 4px 16px 24px;
}

.help-dialog__search {
  flex: 0 0 auto;
}

.help-dialog__kbd {
  padding: 1px 6px;
  border: 1px solid var(--beacon-hairline);
  border-radius: 8px;
  font: inherit;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  white-space: nowrap;
}

.help-dialog__note {
  margin: 8px 4px 0;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.help-dialog__toc {
  padding: 4px 0 0;
  background: transparent;
}

/* A question is often longer than the column: wrapped, not cut off, since
 * the end of it is usually the part that tells two apart. */
.help-dialog__toc-entry.v-list-item {
  padding-inline-start: 24px;
  min-height: 32px;
}

.help-dialog__toc-entry :deep(.v-list-item-title) {
  white-space: normal;
  font-size: 0.8125rem;
  line-height: 1.35;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

/* The open page is marked by its colour alone: its question below carries
 * the tint, and two tinted rows on top of each other read as two choices. */
.help-dialog__toc > .v-list-item--active:not(.help-dialog__toc-entry) :deep(.v-list-item__overlay) {
  opacity: 0;
}

.help-dialog__toc-entry.v-list-item--active :deep(.v-list-item-title) {
  color: rgb(var(--v-theme-primary));
}

.help-dialog__results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
}

.help-dialog__empty {
  margin: 12px 4px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

/* A plain <button> brings the browser's grey face along. */
.help-dialog__result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.help-dialog__result:hover,
.help-dialog__result:focus-visible {
  background: rgba(var(--v-theme-on-surface), 0.06);
  outline: none;
}

.help-dialog__result-page {
  color: rgb(var(--v-theme-primary));
}

.help-dialog__result-snippet {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  display: -webkit-box;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.help-dialog__result mark {
  background: rgba(var(--v-theme-primary), 0.22);
  color: inherit;
  border-radius: 2px;
}
</style>
