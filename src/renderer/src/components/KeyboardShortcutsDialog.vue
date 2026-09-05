<template>
  <v-dialog v-model="visible" max-width="560" scrollable>
    <v-card class="shortcuts-dialog beacon-dialog">
      <v-card-title class="shortcuts-title">{{ $t('shortcuts.title') }}</v-card-title>
      <v-card-text class="shortcuts-body">
        <dl class="shortcut-list">
          <template v-for="entry in entries" :key="entry.labelKey">
            <dt class="shortcut-keys">
              <template v-for="(alternative, index) in entry.keys" :key="alternative">
                <span v-if="index > 0" class="shortcut-or">{{ $t('shortcuts.or') }}</span>
                <span class="shortcut-combo">
                  <kbd v-for="key in alternative.split(' + ')" :key="key">{{ key }}</kbd>
                </span>
              </template>
            </dt>
            <dd class="shortcut-label">{{ $t(entry.labelKey) }}</dd>
          </template>
        </dl>
        <p class="shortcuts-hint text-body-small text-medium-emphasis">
          {{ $t('shortcuts.hint') }}
        </p>
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
import { SHORTCUT_HELP, type ShortcutHelpEntry } from '@/services/keyboardShortcuts'

export default {
  name: 'KeyboardShortcutsDialog',
  data() {
    return {
      visible: false,
      listener: null as (() => void) | null,
    }
  },
  computed: {
    // Ctrl and Cmd both work as the skip modifier (see resolveShortcut()),
    // so the keycap can simply show whichever one this machine's users
    // actually reach for.
    entries(): ShortcutHelpEntry[] {
      if (!this.isMac) return SHORTCUT_HELP
      return SHORTCUT_HELP.map((entry) => ({
        ...entry,
        keys: entry.keys.map((alternative) => alternative.replace('Ctrl', '⌘')),
      }))
    },
    isMac(): boolean {
      return /mac/i.test(navigator.platform || navigator.userAgent)
    },
  },
  mounted() {
    // Toggle, not open: "?" is documented as opening *and* closing this,
    // and it's the one shortcut that still fires while an overlay has
    // focus (see resolveShortcut()).
    this.listener = () => {
      this.visible = !this.visible
    }
    emitter.on('toggleKeyboardShortcuts', this.listener)
  },
  beforeUnmount() {
    if (this.listener) emitter.off('toggleKeyboardShortcuts', this.listener)
  },
}
</script>

<style scoped>
.shortcuts-title {
  padding: 1.25rem 1.5rem 0.5rem;
  font-size: 1.15rem;
  font-weight: 700;
}

.shortcuts-body {
  padding: 0.5rem 1.5rem 1rem;
}

/* Two columns rather than a table: the keycaps size themselves to their
 * own content, the labels take whatever is left. */
.shortcut-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  align-items: baseline;
  gap: 0.55rem 1.25rem;
  margin: 0;
}

.shortcut-keys {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  white-space: nowrap;
}

.shortcut-combo {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
}

/* The separator between two alternatives ("Space or K") — deliberately
 * quieter than the keycaps it sits between. */
.shortcut-or {
  font-size: 0.75rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 55%, transparent);
}

kbd {
  display: inline-block;
  min-width: 1.75rem;
  padding: 0.15rem 0.45rem;
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-on-surface)) 18%, transparent);
}

.shortcut-label {
  margin: 0;
}

.shortcuts-hint {
  margin: 1.25rem 0 0;
}
</style>
