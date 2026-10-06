<template>
  <v-dialog v-model="visible" max-width="860" scrollable>
    <v-card class="help-dialog beacon-dialog">
      <v-card-title class="help-dialog__title">
        <span>{{ $t('help.title') }}</span>
        <v-btn
          icon="mdi-close"
          variant="text"
          density="comfortable"
          :title="$t('common.close')"
          @click="visible = false"
        />
      </v-card-title>
      <div class="help-dialog__toolbar">
        <v-select
          v-model="pageId"
          :items="pageOptions"
          :label="$t('help.topic')"
          variant="solo-filled"
          hide-details
          class="help-dialog__select"
        >
          <template #selection>
            <span class="help-dialog__selection">{{ selectionLabel(pageId) }}</span>
          </template>
        </v-select>
        <p v-if="$i18n.locale !== 'en'" class="text-body-small text-medium-emphasis">
          {{ $t('help.englishOnly') }}
        </p>
      </div>
      <v-divider />
      <v-card-text ref="body">
        <!-- eslint-disable-next-line vue/no-v-html -- our own docs/, rendered by markdown-it with html off, never user input -->
        <div class="beacon-markdown" @click="onContentClick" v-html="html" />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { emitter } from '@/emitter'
import {
  HELP_PAGES,
  findHelpPage,
  pageFor,
  renderHelpPage,
  type HelpDocId,
  type HelpPage,
} from '@/services/help/docs'

type PageOption = { title: string; value: string } | { type: 'subheader'; title: string }

/** The bundled docs (services/help/docs.ts), each opened from where its
 * question comes up and browsable from there: the FAQ topic by topic, then
 * the guides. */
export default {
  name: 'HelpDialog',
  data() {
    return {
      visible: false,
      pageId: pageFor('faq').id,
      listener: null as ((id: HelpDocId) => void) | null,
    }
  },
  computed: {
    pageOptions(): PageOption[] {
      const option = (page: HelpPage) => ({ title: page.title, value: page.id })
      return [
        { type: 'subheader', title: this.$t('help.faq') },
        ...HELP_PAGES.filter((page) => page.doc === 'faq').map(option),
        { type: 'subheader', title: this.$t('help.guides') },
        ...HELP_PAGES.filter((page) => page.doc !== 'faq').map(option),
      ]
    },
    html(): string {
      return renderHelpPage(findHelpPage(this.pageId))
    },
  },
  watch: {
    pageId() {
      void this.scrollTo(null)
    },
  },
  mounted() {
    this.listener = (id: HelpDocId) => this.open(id)
    emitter.on('openHelp', this.listener)
  },
  beforeUnmount() {
    if (this.listener) emitter.off('openHelp', this.listener)
  },
  methods: {
    open(id: HelpDocId) {
      this.pageId = pageFor(id).id
      this.visible = true
      void this.scrollTo(null)
    },
    /** A FAQ topic says it is one, since its title alone ("Party mode")
     * can read like the guide of the same name. */
    selectionLabel(id: string): string {
      const page = findHelpPage(id)
      return page.doc === 'faq' ? `${this.$t('help.faq')}: ${page.title}` : page.title
    },
    /** Links between the bundled docs and within one stay in the dialog;
     * everything else was given target="_blank" when it was rendered. */
    onContentClick(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[data-help-page]')
      if (!link) return
      event.preventDefault()
      const page = link.dataset.helpPage!
      const anchor = link.dataset.helpAnchor || null
      if (page !== this.pageId) {
        this.pageId = page
        // After pageId's own watcher, which scrolls to the top.
        void this.$nextTick(() => this.scrollTo(anchor))
      } else {
        void this.scrollTo(anchor)
      }
    },
    async scrollTo(anchor: string | null) {
      await this.$nextTick()
      const body = (this.$refs.body as { $el?: HTMLElement } | undefined)?.$el
      if (!body) return
      const target = anchor ? body.querySelector(`[id="${CSS.escape(anchor)}"]`) : null
      if (target) target.scrollIntoView?.({ block: 'start' })
      else body.scrollTop = 0
    },
  },
}
</script>

<style scoped>
.help-dialog__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.help-dialog__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 0 16px 16px;
}

.help-dialog__select {
  flex: 0 1 420px;
  min-width: 220px;
}

.help-dialog__selection {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.help-dialog__toolbar p {
  margin: 0;
}
</style>
