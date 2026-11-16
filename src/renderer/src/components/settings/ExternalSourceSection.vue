<template>
  <section v-if="store.mayConfigure" class="settings-section">
    <h2 class="section-title">{{ $t('externalSource.settingsTitle') }}</h2>
    <div class="beacon-panel beacon-panel--flush external-sources">
      <div class="external-sources__head">
        <p class="setting__description external-sources__intro">
          {{ $t('externalSource.settingsWhat') }}
        </p>
        <div class="external-sources__actions">
          <v-btn
            variant="text"
            rounded="pill"
            prepend-icon="mdi-help-circle-outline"
            @click="$emitter.emit('openHelp', 'faq/external-sources')"
          >
            {{ $t('externalSource.help') }}
          </v-btn>
          <v-btn
            variant="text"
            rounded="pill"
            prepend-icon="mdi-robot-outline"
            class="external-sources__ai"
            @click="aiInstructionsOpen = true"
          >
            {{ $t('settings.aiInstructions.title') }}
          </v-btn>
          <v-btn
            variant="text"
            rounded="pill"
            prepend-icon="mdi-storefront-outline"
            class="external-sources__find"
            @click="directoryOpen = true"
          >
            {{ $t('externalSource.findApps') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            rounded="pill"
            prepend-icon="mdi-plus"
            :disabled="store.sources.length >= maxSources"
            class="external-sources__add"
            @click="open(null)"
          >
            {{ $t('externalSource.add') }}
          </v-btn>
        </div>
      </div>

      <ul v-if="store.sources.length" class="external-sources__list">
        <li v-for="source in store.sources" :key="source.id">
          <button type="button" class="external-sources__row" @click="open(source)">
            <span class="external-sources__art">
              <v-icon :icon="source.icon" size="22" />
            </span>
            <span class="external-sources__text">
              <span class="external-sources__name">{{ source.name }}</span>
              <span class="external-sources__status">
                <span class="status-dot" :class="dotClass(source.id)" />
                <span class="setting__hint setting__hint--inline">{{ statusOf(source) }}</span>
              </span>
            </span>
            <v-icon icon="mdi-chevron-right" class="external-sources__chevron" />
          </button>
        </li>
      </ul>
    </div>
    <external-source-dialog
      v-model="dialogOpen"
      :source="editing"
      :preset="preset"
      @saved="onSaved"
    />
    <external-source-directory-dialog v-model="directoryOpen" @add="addFromDirectory" />
    <ai-instructions-dialog
      v-model="aiInstructionsOpen"
      :title="$t('settings.aiInstructions.title')"
      :text="aiInstructions"
    />
  </section>
</template>

<script lang="ts">
import AiInstructionsDialog from '@/components/settings/AiInstructionsDialog.vue'
import ExternalSourceDialog from '@/components/settings/ExternalSourceDialog.vue'
import ExternalSourceDirectoryDialog from '@/components/settings/ExternalSourceDirectoryDialog.vue'
import {
  externalSourceInstructions,
  probeExternalSource,
  type ExternalSource,
  type ExternalSourceProbe,
} from '@/services/connect/externalSource'
import type { DirectoryApp } from '@/services/externalSourceDirectory'
import { useExternalSourceStore } from '@/stores/externalSource'

/** connect's own limit (core/external_source.py), so the button says so
 * before connect has to. */
const MAX_SOURCES = 12

/** The external sources (docs/plans/external-source.md), one row each, and
 * a dialog to add or change one. Only for whoever may change them: an admin
 * on a server, anyone on the desktop app - connect decides, this only
 * follows `may_configure`. */
export default {
  name: 'ExternalSourceSection',
  components: { AiInstructionsDialog, ExternalSourceDialog, ExternalSourceDirectoryDialog },
  data() {
    return {
      dialogOpen: false,
      editing: null as ExternalSource | null,
      /** A new source's name and icon, suggested by an app from the list. */
      preset: null as { name: string; icon: string } | null,
      directoryOpen: false,
      /** What each app said when last asked, by source id. */
      probes: {} as Record<string, ExternalSourceProbe>,
      aiInstructionsOpen: false,
      maxSources: MAX_SOURCES,
    }
  },
  computed: {
    store() {
      return useExternalSourceStore()
    },
    aiInstructions(): string {
      return externalSourceInstructions()
    },
  },
  async created() {
    await this.store.load()
    if (!this.store.mayConfigure) return
    await Promise.all(
      this.store.sources.map(async (source) => {
        try {
          this.probes[source.id] = await probeExternalSource(source.id)
        } catch {
          // No dot then, rather than a wrong one.
        }
      }),
    )
  },
  methods: {
    open(source: ExternalSource | null) {
      this.editing = source
      this.preset = null
      this.dialogOpen = true
    },
    /** An app from the list: a new source with its name and icon, the
     * address still to be entered. */
    addFromDirectory(app: DirectoryApp) {
      this.directoryOpen = false
      this.editing = null
      this.preset = { name: app.name, icon: app.icon }
      this.dialogOpen = true
    },
    onSaved(source: ExternalSource, probe: ExternalSourceProbe) {
      this.probes[source.id] = probe
    },
    dotClass(id: string): string {
      const probe = this.probes[id]
      if (!probe) return 'external-sources__dot--idle'
      return probe.ok ? 'status-dot--ok' : 'status-dot--warn'
    },
    statusOf(source: ExternalSource): string {
      const probe = this.probes[source.id]
      if (probe && !probe.ok) return this.$t('externalSource.unreachable', { reason: probe.error })
      return source.base_url ?? ''
    },
  },
}
</script>

<style scoped>
.external-sources {
  container-type: inline-size;
}

.external-sources__head {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
}

.external-sources__intro.setting__description {
  margin-bottom: 0;
}

.external-sources__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* The help actions stay together on the left; the one thing this
 * section is for sits at the far right, where the other sections' primary
 * action sits too (ServerLinkSection, ApiKeysSection). */
.external-sources__add {
  margin-left: auto;
}

.external-sources__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--beacon-hairline);
}

.external-sources__list li + li {
  border-top: 1px solid var(--beacon-hairline);
}

.external-sources__row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 20px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.external-sources__row:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.external-sources__row:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

/* The same 48px tile as Apps and devices beside it. */
.external-sources__art {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.04);
  color: rgb(var(--v-theme-primary));
}

.external-sources__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.external-sources__name {
  overflow: hidden;
  font-size: 1rem;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.external-sources__status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.external-sources__status .setting__hint {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.external-sources__dot--idle {
  background: rgba(var(--v-theme-on-surface), 0.3);
}

.external-sources__chevron {
  color: rgba(var(--v-theme-on-surface), 0.45);
}

@container (max-width: 480px) {
  .external-sources__actions {
    justify-content: stretch;
  }

  .external-sources__actions > * {
    flex: 1 1 100%;
  }
}
</style>
