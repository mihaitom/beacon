<template>
  <v-dialog v-model="visible" max-width="860" scrollable>
    <v-card class="features-dialog beacon-dialog">
      <v-card-title>{{ $t('features.title') }}</v-card-title>
      <p
        v-if="$i18n.locale !== 'en'"
        class="features-dialog__note text-body-small text-medium-emphasis"
      >
        {{ $t('help.englishOnly') }}
      </p>
      <v-divider />
      <v-card-text ref="body">
        <!-- eslint-disable-next-line vue/no-v-html -- our own README.md, rendered by markdown-it with html off, never user input -->
        <div class="beacon-markdown" @click="onContentClick" v-html="html" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { emitter } from '@/emitter'
import { FEATURES_PAGE, renderHelpPage } from '@/services/help/docs'

/** The README's Features section (services/help/docs.ts's FEATURES_PAGE),
 * kept apart from the help dialog: it answers "what can this do", not a
 * question about something that already happened. */
export default {
  name: 'FeaturesDialog',
  data() {
    return {
      visible: false,
      listener: null as (() => void) | null,
    }
  },
  computed: {
    html(): string {
      return renderHelpPage(FEATURES_PAGE)
    },
  },
  mounted() {
    this.listener = () => this.open()
    emitter.on('openFeatures', this.listener)
  },
  beforeUnmount() {
    if (this.listener) emitter.off('openFeatures', this.listener)
  },
  methods: {
    async open() {
      this.visible = true
      await this.$nextTick()
      const body = (this.$refs.body as { $el?: HTMLElement } | undefined)?.$el
      if (body) body.scrollTop = 0
    },
    /** A heading on this page scrolls here; a bundled doc opens in the help
     * dialog, on top of this one. Everything else was given
     * target="_blank" when it was rendered. */
    onContentClick(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[data-help-page]')
      if (!link) return
      event.preventDefault()
      const page = link.dataset.helpPage!
      const anchor = link.dataset.helpAnchor || null
      if (page === FEATURES_PAGE.id) {
        const body = (this.$refs.body as { $el?: HTMLElement } | undefined)?.$el
        const target = anchor ? body?.querySelector(`[id="${CSS.escape(anchor)}"]`) : null
        target?.scrollIntoView?.({ block: 'start' })
      } else {
        emitter.emit('openHelp', { page, anchor })
      }
    },
  },
}
</script>

<style scoped>
.features-dialog__note {
  margin: 0;
  padding: 0 16px 12px;
}
</style>
