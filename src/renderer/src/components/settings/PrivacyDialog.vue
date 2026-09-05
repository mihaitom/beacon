<template>
  <v-dialog :model-value="modelValue" max-width="720" scrollable @update:model-value="close">
    <v-card class="privacy-card beacon-dialog">
      <v-card-title class="privacy-title">
        <span>{{ $t('privacy.title') }}</span>
        <v-btn
          icon="mdi-close"
          variant="text"
          density="comfortable"
          :title="$t('common.close')"
          @click="close(false)"
        />
      </v-card-title>

      <v-card-text>
        <p class="privacy-intro text-body-medium">{{ $t('privacy.intro') }}</p>

        <section v-for="group in groups" :key="group.key" class="privacy-group">
          <h3 class="privacy-group__title">{{ $t(`privacy.${group.key}Title`) }}</h3>
          <!-- Set off as its own block, because it is a rule about every
             - entry below it and not a line belonging to the first one —
             - which is exactly how it read when it was just another
             - paragraph in the same column. -->
          <p class="privacy-group__rule text-body-small">
            {{ $t(`privacy.${group.key}Hint`) }}
          </p>

          <article v-for="service in group.services" :key="service.key" class="privacy-service">
            <div class="privacy-service__head">
              <span class="privacy-service__name">{{
                $t(`privacy.services.${service.key}.name`)
              }}</span>
              <a
                :href="service.url"
                target="_blank"
                rel="noopener noreferrer"
                class="privacy-service__host"
                >{{ service.host }}</a
              >
              <!-- Only on the ones a setting actually governs, and it names
                 - that setting: "you can turn this off somewhere" is not
                 - worth saying without saying where. -->
              <v-chip v-if="service.optOut" size="x-small" variant="tonal" color="primary">
                {{ $t(`privacy.optOut.${service.optOut}`) }}
              </v-chip>
            </div>
            <p class="privacy-service__purpose text-body-small">
              {{ $t(`privacy.services.${service.key}.purpose`) }}
            </p>
            <p class="privacy-service__sent text-body-small">
              <span class="privacy-service__sent-label">{{ $t('privacy.sends') }}</span>
              {{ $t(`privacy.services.${service.key}.sends`) }}
            </p>
          </article>
        </section>

        <!-- The split above means two different things depending on how
           - Beacon is being run, and only one of them is a real separation
           - of addresses — worth saying plainly rather than letting the
           - desktop app read as more separated than it is. -->
        <section class="privacy-note">
          <h3 class="privacy-group__title">{{ $t('privacy.buildsTitle') }}</h3>
          <p class="privacy-group__rule text-body-small">{{ $t('privacy.builds') }}</p>
        </section>

        <p class="privacy-footnote text-body-small text-medium-emphasis">
          {{ $t('privacy.ownServer') }}
        </p>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="close(false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
// What Beacon says out loud about the connections it makes to services
// that are not yours. Deliberately not called a privacy policy: that is a
// legal document making commitments on someone's behalf, and this is a
// factual list of who gets contacted and what is in the request.
//
// The list is data, not markup, so adding a service is one entry here plus
// its three strings — and so that this file stays something anyone can
// check against the code. Each entry names the host it actually talks to,
// which is what makes it checkable at all.
//
// Split by *who* opens the connection, because that is the part with a
// real consequence: what your Beacon server fetches on your behalf never
// shows the far end your own address, and what your device fetches does.
const SERVICES = {
  fromDevice: [
    {
      key: 'updateCheck',
      host: 'api.github.com',
      url: 'https://github.com/mihaitom/beacon/releases',
    },
    { key: 'radioStream', host: '', url: '' },
  ],
  viaServer: [
    {
      key: 'radioBrowser',
      host: 'api.radio-browser.info',
      url: 'https://www.radio-browser.info/',
    },
    { key: 'stationSite', host: '', url: '' },
    { key: 'lrclib', host: 'lrclib.net', url: 'https://lrclib.net/', optOut: 'lyrics' },
    { key: 'netease', host: 'music.163.com', url: 'https://music.163.com/', optOut: 'lyrics' },
    {
      key: 'simpmusic',
      host: 'api-lyrics.simpmusic.org',
      url: 'https://simpmusic.org/',
      optOut: 'lyrics',
    },
    {
      key: 'musicbrainz',
      host: 'musicbrainz.org',
      url: 'https://musicbrainz.org/',
      // Partial, not full: the toggle stops Home's shelves, but an artist
      // page still looks its own artist up either way (see
      // ArtistDetailView.vue's own comment on why that is deliberate). A
      // plain "can be switched off" chip beside a purpose line saying
      // "whether or not recommendations are on" contradicted itself.
      optOut: 'recommendationsPartial',
    },
    {
      key: 'listenbrainz',
      host: 'labs.api.listenbrainz.org',
      url: 'https://listenbrainz.org/',
      optOut: 'recommendations',
    },
    {
      key: 'deezer',
      host: 'api.deezer.com',
      url: 'https://www.deezer.com/',
      // Same partial gating as MusicBrainz above.
      optOut: 'recommendationsPartial',
    },
    { key: 'plexAuth', host: 'plex.tv', url: 'https://www.plex.tv/' },
  ],
} as const

export default {
  name: 'PrivacyDialog',
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  computed: {
    groups() {
      return [
        { key: 'fromDevice', services: SERVICES.fromDevice },
        { key: 'viaServer', services: SERVICES.viaServer },
      ] as {
        key: string
        services: readonly { key: string; host: string; url: string; optOut?: string }[]
      }[]
    },
  },
  methods: {
    close(value: boolean) {
      this.$emit('update:modelValue', value)
    },
  },
}
</script>

<style scoped>
/* The height cap and the scrolling inside it are .beacon-dialog's now
 * (assets/base.css) - this sheet is where that rule was worked out, and
 * every other content dialog wears the same one. */

.privacy-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.privacy-intro {
  margin-bottom: 20px;
}

.privacy-group + .privacy-group,
.privacy-group + .privacy-note {
  margin-top: 24px;
}

/* Same look as a section, but not one: it lists no services, and the two
 * that do are what "split by who opens the connection" counts. */
.privacy-note {
  display: block;
}

.privacy-group__title {
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.75;
}

/* Indented behind a rule of its own, so it reads as the heading's small
 * print for the whole section rather than as the first entry's own text. */
.privacy-group__rule {
  margin: 8px 0 16px;
  padding: 8px 12px;
  border-inline-start: 2px solid rgb(var(--v-theme-primary));
  border-radius: 0 6px 6px 0;
  background: rgba(255, 255, 255, 0.03);
  opacity: 0.85;
}

/* One block per service, separated the same way the settings panels are —
 * a list of hosts needs the rhythm more than most, since every entry looks
 * like the one above it. */
.privacy-service + .privacy-service {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--beacon-hairline);
}

.privacy-service__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.privacy-service__name {
  font-weight: 600;
}

.privacy-service__host {
  font-family: monospace;
  font-size: 0.8125rem;
  opacity: 0.7;
  color: inherit;
}

.privacy-service__purpose {
  margin-top: 4px;
}

.privacy-service__sent {
  margin-top: 2px;
}

/* The one part of an entry worth finding at a glance — what actually
 * leaves. */
.privacy-service__sent-label {
  font-weight: 600;
  margin-inline-end: 4px;
}

.privacy-footnote {
  margin-top: 24px;
}
</style>
