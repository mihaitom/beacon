<template>
  <v-dialog
    :model-value="modelValue"
    max-width="560"
    scrollable
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="beacon-dialog source-directory">
      <v-card-title class="source-directory__head">
        <span>{{ $t('externalSource.directoryTitle') }}</span>
        <v-btn
          icon="mdi-help-circle-outline"
          variant="text"
          density="comfortable"
          :title="$t('externalSource.help')"
          @click="openListingHelp"
        />
      </v-card-title>
      <v-card-text class="source-directory__body">
        <!-- Said before the list, every time: these are someone else's. -->
        <p class="source-directory__notice text-body-small">
          <v-icon icon="mdi-account-group-outline" size="18" />
          <span>{{ $t('externalSource.directoryNotice') }}</span>
        </p>

        <div v-if="loading" class="source-directory__list" aria-busy="true">
          <v-skeleton-loader v-for="n in 3" :key="n" type="list-item-avatar-two-line" />
        </div>

        <div v-else-if="failed" class="source-directory__failed">
          <span class="text-body-medium">{{ $t('externalSource.directoryFailed') }}</span>
          <v-btn
            variant="tonal"
            rounded="pill"
            prepend-icon="mdi-refresh"
            class="source-directory__retry"
            @click="load"
          >
            {{ $t('externalSource.directoryRetry') }}
          </v-btn>
        </div>

        <p v-else-if="!apps.length" class="source-directory__empty text-body-medium">
          {{ $t('externalSource.directoryEmpty') }}
        </p>

        <ul v-else class="source-directory__list">
          <li v-for="app in apps" :key="app.repository" class="source-directory__row">
            <span class="source-directory__art">
              <v-icon :icon="app.icon" size="22" />
            </span>
            <div class="source-directory__text">
              <span class="source-directory__name">{{ app.name }}</span>
              <span class="source-directory__description text-body-small">
                {{ app.description }}
              </span>
              <!-- A plain link: main/index.ts sends it to the browser. -->
              <a
                class="source-directory__repo text-body-small"
                :href="app.repository"
                target="_blank"
                rel="noopener noreferrer"
              >
                <v-icon icon="mdi-open-in-new" size="14" />
                {{ label(app.repository) }}
              </a>
            </div>
            <v-btn
              variant="tonal"
              rounded="pill"
              class="source-directory__add"
              @click="$emit('add', app)"
            >
              {{ $t('externalSource.directoryAdd') }}
            </v-btn>
          </li>
        </ul>
      </v-card-text>
      <v-card-actions>
        <v-btn
          variant="text"
          rounded="pill"
          class="source-directory__list-yours"
          @click="openListingHelp"
        >
          {{ $t('externalSource.directoryListYours') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">
          {{ $t('common.close') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import {
  fetchDirectory,
  repositoryLabel,
  type DirectoryApp,
} from '@/services/externalSourceDirectory'

/** The apps others have listed in community/external-sources.json, read
 * from main whenever the dialog opens. "Add" hands one to the section,
 * which opens the usual dialog with its name and icon filled in: the
 * address is wherever the listener runs it, which no list can know. */
export default {
  name: 'ExternalSourceDirectoryDialog',
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ['update:modelValue', 'add'],
  data() {
    return {
      apps: [] as DirectoryApp[],
      loading: false,
      failed: false,
    }
  },
  watch: {
    modelValue: {
      immediate: true,
      handler(open: boolean) {
        if (open) void this.load()
      },
    },
  },
  methods: {
    async load() {
      this.loading = true
      this.failed = false
      try {
        this.apps = await fetchDirectory()
      } catch (error) {
        console.error('[external-source] Could not read the list of apps:', error)
        this.failed = true
      } finally {
        this.loading = false
      }
    },
    label(url: string): string {
      return repositoryLabel(url)
    },
    openListingHelp() {
      this.$emitter.emit('openHelp', {
        page: 'faq/external-sources',
        anchor: 'how-do-i-list-my-own-app',
      })
    },
  },
}
</script>

<style scoped>
.source-directory__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.source-directory__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* A quiet line, not an alert: it is what the list is, not news. */
.source-directory__notice {
  display: flex;
  gap: 10px;
  margin: 0;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.source-directory__notice .v-icon {
  flex: none;
  margin-top: 1px;
  color: rgb(var(--v-theme-primary));
}

.source-directory__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.source-directory__row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 14px 0;
}

.source-directory__row + .source-directory__row {
  border-top: 1px solid var(--beacon-hairline);
}

/* The same 48px tile as the sources' own list in the settings. */
.source-directory__art {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.04);
  color: rgb(var(--v-theme-primary));
}

.source-directory__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.source-directory__name {
  font-size: 1rem;
  font-weight: 600;
}

.source-directory__description {
  color: rgba(var(--v-theme-on-surface), 0.75);
}

.source-directory__repo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
  overflow: hidden;
  color: rgba(var(--v-theme-on-surface), 0.6);
  text-decoration: none;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.source-directory__repo:hover {
  color: rgb(var(--v-theme-primary));
}

.source-directory__failed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.source-directory__empty {
  margin: 0;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

@media (max-width: 480px) {
  .source-directory__row {
    grid-template-columns: 48px minmax(0, 1fr);
  }

  .source-directory__add {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
