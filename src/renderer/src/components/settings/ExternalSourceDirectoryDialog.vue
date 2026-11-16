<template>
  <v-dialog
    :model-value="modelValue"
    max-width="640"
    scrollable
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="beacon-dialog source-directory">
      <!-- The same hero as the release notes: a list to browse, not a form. -->
      <div class="source-directory__hero">
        <div class="source-directory__hero-icon">
          <v-icon icon="mdi-storefront-outline" />
        </div>
        <div class="source-directory__hero-text">
          <div class="eyebrow-label">{{ $t('externalSource.settingsTitle') }}</div>
          <h2>{{ $t('externalSource.directoryTitle') }}</h2>
          <p>{{ $t('externalSource.directorySubtitle') }}</p>
        </div>
        <v-btn
          icon="mdi-help-circle-outline"
          variant="text"
          density="comfortable"
          class="source-directory__help"
          :title="$t('externalSource.help')"
          @click="openListingHelp"
        />
      </div>

      <v-divider />

      <v-card-text class="source-directory__body">
        <div v-if="loading" class="source-directory__cards" aria-busy="true">
          <v-skeleton-loader
            v-for="n in 2"
            :key="n"
            type="list-item-avatar-three-line"
            class="source-directory__card"
          />
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

        <ul v-else class="source-directory__cards">
          <li v-for="app in apps" :key="app.repository" class="source-directory__card">
            <div class="source-directory__top">
              <span class="source-directory__art">
                <img
                  v-if="app.image && !failedImages.includes(app.image)"
                  :src="app.image"
                  alt=""
                  loading="lazy"
                  @error="failedImages.push(app.image)"
                />
                <v-icon v-else :icon="app.icon" size="26" />
              </span>
              <div class="source-directory__title">
                <span class="source-directory__name">{{ app.name }}</span>
                <!-- Credited like the release notes credit people. -->
                <a
                  class="source-directory__author"
                  :href="`https://github.com/${app.author}`"
                  :title="$t('externalSource.directoryAuthor', { login: app.author })"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span class="source-directory__avatar">
                    <img
                      v-if="!failedAvatars.includes(app.author)"
                      :src="avatar(app.author)"
                      alt=""
                      loading="lazy"
                      @error="failedAvatars.push(app.author)"
                    />
                    <template v-else>{{ app.author.charAt(0).toUpperCase() }}</template>
                  </span>
                  <span class="text-body-small">@{{ app.author }}</span>
                </a>
              </div>
            </div>
            <p class="source-directory__description text-body-medium">{{ app.description }}</p>
            <div class="source-directory__foot">
              <span class="source-directory__repo text-body-small" :title="app.repository">
                <v-icon :icon="repoIcon(app.repository)" size="16" />
                <span>{{ label(app.repository) }}</span>
              </span>
              <!-- The project, not an install: its README says how to run
                   it, and it is added like any other source afterwards.
                   A plain link; main/index.ts sends it to the browser. -->
              <v-btn
                color="primary"
                variant="flat"
                rounded="pill"
                append-icon="mdi-open-in-new"
                class="source-directory__open"
                :href="app.repository"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ $t('externalSource.directoryOpen') }}
              </v-btn>
            </div>
          </li>
        </ul>

        <!-- Said under the list, every time: Beacon runs none of these. -->
        <p class="source-directory__notice text-body-small">
          <v-icon icon="mdi-shield-alert-outline" size="16" />
          <span>{{ $t('externalSource.directoryNotice') }}</span>
        </p>
      </v-card-text>

      <v-card-actions class="source-directory__actions">
        <v-btn
          variant="text"
          rounded="pill"
          prepend-icon="mdi-source-pull"
          class="source-directory__list-yours"
          @click="openListingHelp"
        >
          {{ $t('externalSource.directoryListYours') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" rounded="pill" @click="$emit('update:modelValue', false)">
          {{ $t('common.close') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import {
  avatarUrl,
  fetchDirectory,
  repositoryLabel,
  type DirectoryApp,
} from '@/services/externalSourceDirectory'

/** The apps listed in community/external-sources.json, read whenever the
 * dialog opens. Each one leads to its repository and nothing more: an app
 * is run as its README says and then added like any other source, so
 * nothing here looks like a one-click install. */
export default {
  name: 'ExternalSourceDirectoryDialog',
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      apps: [] as DirectoryApp[],
      loading: false,
      failed: false,
      /** Authors whose avatar did not load: their initial instead. */
      failedAvatars: [] as string[],
      /** Pictures that did not load: the icon instead. */
      failedImages: [] as string[],
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
    avatar(author: string): string {
      return avatarUrl(author)
    },
    /** GitHub's mark for a GitHub repository, a neutral one elsewhere. */
    repoIcon(url: string): string {
      return new URL(url).hostname === 'github.com' ? 'mdi-github' : 'mdi-source-repository'
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
.source-directory__hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 1.25rem;
  align-items: center;
  padding: 1.5rem 1.5rem 1rem;
}

.source-directory__hero-icon {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 16px;
  font-size: 2.25rem;
  color: rgb(var(--v-theme-primary));
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, rgb(var(--v-theme-surface)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-primary)) 18%, transparent);
}

.source-directory__hero-icon .v-icon {
  font-size: inherit;
}

.source-directory__hero h2 {
  margin: 0.25rem 0 0;
  font-size: 1.4rem;
}

.source-directory__hero p {
  margin: 0.375rem 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
}

.source-directory__help {
  align-self: start;
}

.source-directory__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 16px;
}

.source-directory__cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.source-directory__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid var(--beacon-hairline);
  background: rgba(var(--v-theme-on-surface), 0.03);
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.source-directory__card:hover {
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 40%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 5%, transparent);
}

.source-directory__top {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.source-directory__art {
  display: grid;
  flex: none;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  overflow: hidden;
  color: rgb(var(--v-theme-primary));
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, rgb(var(--v-theme-surface)));
}

.source-directory__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.source-directory__title {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.source-directory__name {
  max-width: 100%;
  overflow: hidden;
  font-size: 1.1rem;
  font-weight: 700;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* The release notes' contributor chip. */
.source-directory__author {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 2px 10px 2px 2px;
  border-radius: 999px;
  color: inherit;
  text-decoration: none;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  transition: background 0.15s ease;
}

.source-directory__author:hover,
.source-directory__author:focus-visible {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
}

.source-directory__avatar {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  overflow: hidden;
  border-radius: 50%;
  font-size: 0.65rem;
  font-weight: 700;
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
}

.source-directory__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.source-directory__description {
  margin: 0;
  color: rgba(var(--v-theme-on-surface), 0.8);
}

.source-directory__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.source-directory__repo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.source-directory__repo span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.source-directory__open {
  flex: none;
}

/* A quiet line, not an alert: it is what the list is, not news. */
.source-directory__notice {
  display: flex;
  gap: 8px;
  margin: 0;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.source-directory__notice .v-icon {
  flex: none;
  margin-top: 1px;
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

.source-directory__actions {
  padding: 8px 16px 16px;
}

@media (max-width: 600px) {
  .source-directory__hero {
    gap: 0.75rem;
    padding: 1rem 1rem 0.75rem;
  }

  .source-directory__hero-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    font-size: 1.6rem;
  }

  .source-directory__hero h2 {
    font-size: 1.2rem;
  }
}
</style>
