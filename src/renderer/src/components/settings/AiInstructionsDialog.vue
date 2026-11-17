<template>
  <v-dialog
    :model-value="modelValue"
    max-width="560"
    @update:model-value="$emit('update:modelValue', $event)"
    @after-leave="copied = false"
  >
    <v-card class="ai-instructions">
      <v-card-title>{{ title }}</v-card-title>
      <v-card-text>
        <v-textarea
          :model-value="text"
          readonly
          rows="14"
          no-resize
          variant="solo-filled"
          hide-details
          spellcheck="false"
          class="ai-instructions__text"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn
          variant="text"
          class="ai-instructions__close"
          @click="$emit('update:modelValue', false)"
        >
          {{ $t('common.close') }}
        </v-btn>
        <v-btn
          color="primary"
          rounded="pill"
          class="ai-instructions__copy"
          :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'"
          @click="copy"
        >
          {{ copied ? $t('settings.aiInstructions.copied') : $t('settings.aiInstructions.copy') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
/**
 * The prompt an AI assistant gets, shown before it leaves: what will be
 * pasted into a chat is not something to copy blind. The textarea is the
 * only control - a second copy of the words would drift from it.
 */
export default {
  name: 'AiInstructionsDialog',
  props: {
    modelValue: { type: Boolean, required: true },
    title: { type: String, required: true },
    text: { type: String, required: true },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      copied: false,
      copiedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  beforeUnmount() {
    clearTimeout(this.copiedTimer)
  },
  methods: {
    async copy() {
      try {
        await navigator.clipboard.writeText(this.text)
      } catch (error) {
        // The text is on screen and selectable, so this is not worth a toast.
        console.error('[settings] Failed to copy instructions:', error)
        return
      }
      clearTimeout(this.copiedTimer)
      this.copied = true
      this.copiedTimer = setTimeout(() => {
        this.copied = false
      }, 2000)
    },
  },
}
</script>

<style scoped>
.ai-instructions.v-card {
  border-radius: 16px;
}

/* The prompt is long. On a short window it scrolls inside the field rather
 * than pushing the dialog past the screen. */
.ai-instructions__text :deep(textarea) {
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  max-height: 45vh;
}
</style>
