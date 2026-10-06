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
          v-model="docId"
          :items="docOptions"
          :label="$t('help.document')"
          variant="solo-filled"
          hide-details
          class="help-dialog__select"
        />
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
import { HELP_DOCS, findHelpDoc, renderHelpDoc, type HelpDocId } from '@/services/help/docs'

/** The bundled docs (services/help/docs.ts), each opened from where its
 * question comes up and browsable from there. */
export default {
  name: 'HelpDialog',
  data() {
    return {
      visible: false,
      docId: 'faq' as HelpDocId,
      listener: null as ((id: HelpDocId) => void) | null,
    }
  },
  computed: {
    docOptions(): { title: string; value: HelpDocId }[] {
      return HELP_DOCS.map((doc) => ({ title: doc.title, value: doc.id }))
    },
    html(): string {
      return renderHelpDoc(findHelpDoc(this.docId))
    },
  },
  watch: {
    docId() {
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
      this.docId = id
      this.visible = true
      void this.scrollTo(null)
    },
    /** Links between the bundled docs and within one stay in the dialog;
     * everything else was given target="_blank" when it was rendered. */
    onContentClick(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
        'a[data-help-anchor]',
      )
      if (!link) return
      event.preventDefault()
      const doc = link.dataset.helpDoc as HelpDocId | ''
      const anchor = link.dataset.helpAnchor || null
      if (doc && doc !== this.docId) {
        this.docId = doc
        // After docId's own watcher, which scrolls to the top.
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
  flex: 0 1 320px;
  min-width: 220px;
}

.help-dialog__toolbar p {
  margin: 0;
}
</style>
