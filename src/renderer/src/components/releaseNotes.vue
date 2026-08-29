<template>
  <v-dialog v-model="visible" max-width="920" scrollable transition="dialog-top-transition">
    <v-card class="release-dialog">
      <div class="release-hero">
        <div class="release-hero__icon-wrap">
          <v-icon :class="['release-icon', { spin: iconAnimation }]">
            mdi-star-circle-outline
          </v-icon>
        </div>
        <div class="release-hero__text">
          <div class="release-kicker">{{ $t('releaseNotes.title') }}</div>
          <h2>{{ $t('releaseNotes.heading') }}</h2>
          <p>{{ $t('releaseNotes.subheading') }}</p>
        </div>
      </div>

      <v-divider />

      <v-card-text class="release-body">
        <div class="release-toolbar">
          <v-select
            v-model="selectedVersion"
            :items="versionOptions"
            item-title="title"
            item-value="value"
            :label="$t('releaseNotes.version')"
            variant="solo-filled"
            density="comfortable"
            hide-details
            class="version-select"
          >
          </v-select>
          <v-chip color="primary" variant="flat">{{
            $t('releaseNotes.current', { version: appVersion })
          }}</v-chip>
        </div>

        <!-- eslint-disable-next-line vue/no-v-html -- selectedHtml is our own CHANGELOG.md, rendered at build time, never user input -->
        <div v-if="selectedHtml" class="changelog-content" v-html="selectedHtml"></div>

        <div v-else class="empty-state">{{ $t('releaseNotes.empty') }}</div>
      </v-card-text>
      <v-card-actions class="release-actions">
        <v-spacer />
        <v-btn variant="text" @click="closeDialog">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import MarkdownIt from 'markdown-it'
import { emitter } from '@/emitter'
import { useAuthStore } from '@/stores/auth'
import changelogRaw from '../../../../CHANGELOG.md?raw'
import packageJson from '../../../../package.json'

const md = new MarkdownIt({ html: false, linkify: true })

const STORAGE_PREFIX = 'releaseNotesSeen'

type ChangelogEntry = {
  version: string
  date: string
  /** Raw markdown for this version's whole section (everything below its
   * `## [x] - y` heading down to the next one) — kept as-is rather than
   * flattened into a custom section/item model, so headings, nested lists,
   * bold text, links and blockquotes all render through markdown-it
   * unchanged instead of being lost. */
  body: string
}

type VersionOption = {
  title: string
  value: string
}

function parseChangelog(markdown: string): ChangelogEntry[] {
  const lines = markdown.split(/\r?\n/)
  const entries: (ChangelogEntry & { lines: string[] })[] = []
  let current: (ChangelogEntry & { lines: string[] }) | null = null

  for (const line of lines) {
    const versionMatch = line.match(/^##\s+\[(.+?)\]\s+-\s+(.+)$/)
    if (versionMatch) {
      current = { version: versionMatch[1] ?? '', date: versionMatch[2] ?? '', body: '', lines: [] }
      entries.push(current)
      continue
    }
    current?.lines.push(line)
  }

  return entries.map(({ version, date, lines: bodyLines }) => ({
    version,
    date,
    body: bodyLines.join('\n').trim(),
  }))
}

export default defineComponent({
  name: 'ReleaseNotes',
  data() {
    const entries = parseChangelog(changelogRaw)
    const defaultVersion =
      entries.find((entry) => entry.version === packageJson.version)?.version ??
      entries[0]?.version ??
      packageJson.version

    return {
      visible: false,
      appVersion: packageJson.version,
      selectedVersion: defaultVersion,
      changelogEntries: entries,
      iconAnimation: false,
      listener: null as (() => void) | null,
    }
  },
  computed: {
    versionOptions(): VersionOption[] {
      return this.changelogEntries.map((entry) => ({
        title: `v${entry.version} - ${entry.date}`,
        value: entry.version,
      }))
    },
    selectedEntry(): ChangelogEntry | null {
      return this.changelogEntries.find((entry) => entry.version === this.selectedVersion) ?? null
    },
    selectedHtml(): string {
      return this.selectedEntry ? md.render(this.selectedEntry.body) : ''
    },
    storageKey(): string {
      return `${STORAGE_PREFIX}:${this.appVersion}`
    },
    authStore() {
      return useAuthStore()
    },
  },
  watch: {
    // Auto-open only once logged in — this used to fire unconditionally on
    // mount (App.vue mounts this globally regardless of route), popping up
    // right on top of the login screen before anyone had even signed in.
    // immediate: true here is safe (unlike App.vue's own authenticated
    // watcher, which deliberately omits it to avoid racing the router
    // guard's restore() with a forced /login redirect) — this only ever
    // *shows* a dialog, never navigates, so there's nothing to race.
    // showAutoIfNeeded() is itself idempotent (see its own comment), so
    // this firing again on a later real login after a logout is harmless.
    'authStore.authenticated': {
      immediate: true,
      handler(authenticated: boolean) {
        if (authenticated) this.showAutoIfNeeded()
      },
    },
  },
  mounted() {
    this.listener = () => this.openDialog(true)
    emitter.on('openReleaseNotes', this.listener)
    setTimeout(() => {
      this.iconAnimation = true
    }, 50)
  },
  beforeUnmount() {
    if (this.listener) {
      emitter.off('openReleaseNotes', this.listener)
    }
  },
  methods: {
    showAutoIfNeeded() {
      const seenVersion = window.localStorage.getItem(this.storageKey)
      if (seenVersion !== this.appVersion) {
        this.openDialog(true)
      }
    },
    openDialog(autoOpen = false) {
      if (this.versionOptions.length > 0) {
        this.selectedVersion =
          this.changelogEntries.find((entry) => entry.version === this.appVersion)?.version ??
          this.versionOptions[0]?.value ??
          this.appVersion
      }
      this.visible = true
      if (autoOpen) {
        window.localStorage.setItem(this.storageKey, this.appVersion)
      }
    },
    closeDialog() {
      this.visible = false
      window.localStorage.setItem(this.storageKey, this.appVersion)
    },
  },
})
</script>

<style scoped>
.release-dialog {
  overflow: hidden;
  color: rgb(var(--v-theme-on-surface));
}

.release-hero {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1.25rem;
  align-items: center;
  padding: 1.5rem 1.5rem 1rem;
}

.release-hero__icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 20px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, rgb(var(--v-theme-surface)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-primary)) 18%, transparent);
}

.release-icon {
  color: rgb(var(--v-theme-primary));
  font-size: 3rem;
  transform: rotateY(0deg);
  transition: transform 0.9s cubic-bezier(0.8, -0.4, 0.5, 1);
}

.release-icon.spin {
  transform: rotateY(540deg);
}

.release-kicker {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.75rem;
  font-weight: 700;
  color: rgb(var(--v-theme-primary));
  margin-bottom: 0.25rem;
}

.release-hero h2 {
  margin: 0;
  font-size: 1.4rem;
}

.release-hero p {
  margin: 0.5rem 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
}

.release-body {
  padding: 1.25rem 1.5rem 1rem;
  max-height: 68vh;
}

.release-toolbar {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.version-select {
  max-width: 260px;
  min-width: 220px;
}

/* selectedHtml is markdown-it's rendered output, injected via v-html — it
 * never gets Vue's scope-id, so every selector reaching into it needs
 * :deep(). Styled to loosely match the old hand-rolled section cards
 * (heading pill, indented lists) while actually rendering the markdown
 * (bold, links, nested lists, blockquotes, code) instead of flattening it. */
.changelog-content :deep(h3) {
  margin: 1.25rem 0 0.5rem;
  padding: 0.5rem 0.9rem;
  border-radius: 12px;
  font-weight: 700;
  font-size: 1rem;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 82%, rgb(var(--v-theme-primary)) 18%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, transparent);
}

.changelog-content :deep(h3:first-child) {
  margin-top: 0;
}

.changelog-content :deep(p) {
  margin: 0.5rem 0;
}

.changelog-content :deep(ul) {
  margin: 0.25rem 0 0.25rem 1.25rem;
  padding-left: 0;
}

.changelog-content :deep(li) {
  margin-bottom: 0.35rem;
}

.changelog-content :deep(li > ul) {
  margin-top: 0.35rem;
}

.changelog-content :deep(strong) {
  color: rgb(var(--v-theme-on-surface));
}

.changelog-content :deep(a) {
  color: rgb(var(--v-theme-primary));
}

.changelog-content :deep(code) {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
}

.changelog-content :deep(blockquote) {
  margin: 0.75rem 0;
  padding: 0.5rem 0.9rem;
  border-left: 3px solid rgb(var(--v-theme-primary));
  background: color-mix(
    in srgb,
    rgb(var(--v-theme-surface)) 95%,
    rgb(var(--v-theme-on-surface)) 5%
  );
  border-radius: 0 8px 8px 0;
}

.changelog-content :deep(blockquote p) {
  margin: 0.2rem 0;
}

.empty-state {
  padding: 1rem 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
}

.release-actions {
  padding: 0.75rem 1rem 1rem;
}

@media (max-width: 600px) {
  .release-hero {
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    padding: 1rem 1rem 0.75rem;
  }

  .release-hero__icon-wrap {
    width: 44px;
    height: 44px;
    border-radius: 14px;
  }

  .release-icon {
    font-size: 1.8rem;
  }

  .release-kicker {
    font-size: 0.65rem;
  }

  .release-hero h2 {
    font-size: 1.05rem;
  }

  .release-hero p {
    font-size: 0.8rem;
    margin-top: 0.25rem;
  }

  .release-body {
    padding: 0.85rem 1rem 0.5rem;
    max-height: 58vh;
  }

  /* Select-then-chip used to just wrap onto a second line at this width,
   * leaving an odd half-empty row — a clean vertical stack reads better
   * than letting flex-wrap decide where the break falls. */
  .release-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .version-select {
    max-width: 100%;
    min-width: 0;
    width: 100%;
  }

  .release-actions {
    padding: 0.5rem 0.75rem 0.75rem;
  }
}
</style>
