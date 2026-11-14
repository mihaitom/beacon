<template>
  <div class="external-view">
    <v-progress-circular v-if="!store.loaded" indeterminate class="external-view__loading" />

    <!-- A link to a source that has since been removed. -->
    <empty-state
      v-else-if="!source"
      icon="mdi-web"
      :title="$t('externalSource.goneTitle')"
      :text="$t('externalSource.goneText')"
    >
      <v-btn v-if="store.mayConfigure" variant="tonal" to="/settings">
        {{ $t('externalSource.openSettings') }}
      </v-btn>
    </empty-state>

    <!-- Sandboxed twice: here, and by the CSP header connect sends with every
       - response under /external-ui/. No allow-same-origin, so the page gets
       - an origin of its own and none of Beacon's session or storage; no
       - allow-top-navigation, so it cannot take the app away. -->
    <iframe
      v-else
      ref="frame"
      :key="frameSrc"
      :src="frameSrc"
      :title="source.name"
      class="external-view__frame"
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
      allow=""
    />
  </div>
</template>

<script lang="ts">
import EmptyState from '@/components/EmptyState.vue'
import { useAuthStore } from '@/stores/auth'
import { useExternalSourceStore } from '@/stores/externalSource'
import { usePlaybackStore } from '@/stores/playback'
import {
  parsePlayMessage,
  registerExternalItem,
  type ExternalSource,
} from '@/services/connect/externalSource'
import { connectErrorMessage } from '@/services/connect/errorMessage'

/** The colours a page may want, by the names it is told in the docs. */
const THEME_COLORS = [
  'background',
  'surface',
  'on-background',
  'on-surface',
  'primary',
  'on-primary',
  'secondary',
  'error',
] as const

/**
 * An external source's tab (docs/plans/external-source.md), the one the
 * route names: its own page in a sandboxed frame, and a message bridge to it. The page asks to play,
 * Beacon decides; it learns the theme and what is playing, nothing else.
 */
export default {
  name: 'ExternalSourceView',
  components: { EmptyState },
  computed: {
    store() {
      return useExternalSourceStore()
    },
    source(): ExternalSource | undefined {
      return this.store.byId(String(this.$route.params.id ?? ''))
    },
    frameSrc(): string {
      const path = this.source?.ui_path
      return path ? `${useAuthStore().connectUrl}${path}` : ''
    },
    themeKey(): string {
      const theme = this.$vuetify.theme.current
      return `${theme.dark}:${THEME_COLORS.map((name) => theme.colors[name]).join(',')}`
    },
    nowPlayingKey(): string {
      const song = usePlaybackStore().currentSong
      return song ? song.id : ''
    },
  },
  watch: {
    themeKey() {
      this.sendTheme()
    },
    nowPlayingKey() {
      this.sendNowPlaying()
    },
  },
  created() {
    void this.store.load()
  },
  mounted() {
    window.addEventListener('message', this.onMessage)
  },
  beforeUnmount() {
    window.removeEventListener('message', this.onMessage)
  },
  methods: {
    frameWindow(): Window | null {
      return (this.$refs.frame as HTMLIFrameElement | undefined)?.contentWindow ?? null
    },
    /** `*` as the target: the sandboxed page's origin is opaque and cannot
     * be named. Only the theme and the current song's names go out. */
    post(message: Record<string, unknown>): void {
      this.frameWindow()?.postMessage(message, '*')
    },
    sendTheme(): void {
      const theme = this.$vuetify.theme.current
      const colors: Record<string, string> = {}
      for (const name of THEME_COLORS) {
        const value = theme.colors[name]
        if (typeof value === 'string') colors[name] = value
      }
      this.post({ type: 'beacon.theme', dark: theme.dark, colors })
    },
    sendNowPlaying(): void {
      const song = usePlaybackStore().currentSong
      this.post({
        type: 'beacon.nowPlaying',
        item: song ? { title: song.title, artist: song.artist, album: song.album } : null,
      })
    },
    async onMessage(event: MessageEvent): Promise<void> {
      // Only the frame's own messages; anything else on this window is not
      // the page's to send.
      const frame = this.frameWindow()
      if (!frame || event.source !== frame) return
      const data = event.data as { type?: unknown } | null
      if (data?.type === 'beacon.ready') {
        this.sendTheme()
        this.sendNowPlaying()
        return
      }
      const request = parsePlayMessage(event.data)
      const source = this.source
      if (!request || !source) return
      try {
        const song = await registerExternalItem(source.id, request.item)
        const playback = usePlaybackStore()
        if (request.mode === 'next') playback.queueNext([song])
        else if (request.mode === 'queue') playback.addToQueue([song])
        else await playback.playSongList([song], 0)
        this.post({ type: 'beacon.played', ok: true })
      } catch (error) {
        const { message } = connectErrorMessage(error)
        this.post({ type: 'beacon.played', ok: false, error: message })
        this.$emitter.emit('toast', {
          level: 'error',
          title: source.name,
          message: this.$t('externalSource.playFailed', { reason: message }),
        })
      }
    },
  },
}
</script>

<style scoped>
.external-view {
  display: flex;
  flex-direction: column;
  height: calc(100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
}

.external-view__loading {
  margin: 48px auto;
}

.external-view__frame {
  flex: 1;
  width: 100%;
  border: 0;
  /* The page's own background shows until it has drawn; this keeps that
     moment from flashing white in the dark theme. */
  background: rgb(var(--v-theme-background));
}
</style>
