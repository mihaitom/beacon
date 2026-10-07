<template>
  <div class="guest-player-bar" :class="{ 'guest-player-bar--compact': compact }">
    <div v-if="!compact" class="guest-player-bar__song">
      <guest-cover :src="coverUrl" :size="56" :fallback-icon="radio ? 'mdi-radio' : 'mdi-music'" />
      <div class="guest-player-bar__labels">
        <div class="text-body-medium guest-player-bar__title">{{ title }}</div>
        <div class="text-body-small text-medium-emphasis guest-player-bar__title">
          {{ subtitle }}
        </div>
      </div>
    </div>

    <div class="guest-player-bar__center">
      <!-- Where the host has play/pause: for a guest it starts and stops
       - their own stream. Stop rather than pause, because coming back
       - rejoins the party where it is now, not where this guest left. -->
      <v-btn
        class="guest-player-bar__play"
        :icon="playIcon"
        variant="flat"
        color="primary"
        :size="compact ? 'default' : 'large'"
        density="comfortable"
        :loading="store.listenState === 'connecting'"
        :title="playLabel"
        :aria-label="playLabel"
        :aria-pressed="listening"
        @click="toggle"
      />
      <div class="guest-player-bar__seek">
        <span v-if="radio" class="text-body-small text-medium-emphasis guest-player-bar__live">
          {{ $t('partyGuest.live') }}
        </span>
        <template v-else>
          <span class="text-body-small text-medium-emphasis guest-player-bar__time">
            {{ formatTime(store.position) }}
          </span>
          <!-- Shows where the party is in the song; guests cannot seek. -->
          <waveform-bars
            :peaks="store.waveform.peaks"
            :model-value="store.position"
            :duration="store.displayDuration"
            disabled
            :dimmed="!store.displaySong"
          />
          <span class="text-body-small text-medium-emphasis guest-player-bar__time">
            {{ formatTime(store.displayDuration) }}
          </span>
        </template>
      </div>
    </div>

    <!-- iOS ignores a page's volume, so there the phone's buttons are the
     - only control and a slider would do nothing. On a phone the buttons
     - are the control anyway. -->
    <div v-if="!compact" class="guest-player-bar__volume">
      <template v-if="store.volumeAdjustable">
        <v-btn
          :icon="store.volume === 0 ? 'mdi-volume-off' : 'mdi-volume-high'"
          variant="text"
          density="comfortable"
          :title="$t('player.mute')"
          :aria-label="$t('player.mute')"
          @click="toggleMute"
        />
        <touch-volume-slider
          :model-value="store.volume"
          :aria-label="$t('player.volume')"
          class="guest-player-bar__slider"
          @update:model-value="store.setVolume($event)"
        />
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import WaveformBars from '@/components/player/WaveformBars.vue'
import TouchVolumeSlider from '@/components/mobile/TouchVolumeSlider.vue'
import GuestCover from './GuestCover.vue'
import { usePartyGuestStore } from '../store'

/** The online party's player bar: the guest's own play button for the
 * stream, where the song is, and the guest's own volume. Shown only while
 * the host offers the online party. */
export default {
  name: 'GuestPlayerBar',
  components: { WaveformBars, TouchVolumeSlider, GuestCover },
  props: {
    compact: { type: Boolean, default: false },
  },
  data() {
    return { volumeBeforeMute: 100 }
  },
  computed: {
    store() {
      return usePartyGuestStore()
    },
    listening(): boolean {
      return this.store.listenState !== 'off' && this.store.listenState !== 'failed'
    },
    radio(): boolean {
      return !this.store.displaySong && Boolean(this.store.snapshot?.radio)
    },
    coverUrl(): string | null {
      return this.store.displaySong?.cover ?? this.store.snapshot?.radio?.logo ?? null
    },
    title(): string {
      const radio = this.store.snapshot?.radio
      return this.store.displaySong?.title ?? radio?.now_playing ?? radio?.name ?? ''
    },
    subtitle(): string {
      const song = this.store.displaySong
      if (song) return song.artist ?? ''
      const radio = this.store.snapshot?.radio
      return radio?.now_playing ? radio.name : ''
    },
    /** A stream given up on shows as a retry: the tap that starts it again
     * is the same one. */
    playIcon(): string {
      if (this.store.listenState === 'failed') return 'mdi-refresh'
      return this.listening ? 'mdi-stop' : 'mdi-play'
    },
    playLabel(): string {
      if (this.store.listenState === 'connecting') return this.$t('partyGuest.listenConnecting')
      if (this.store.listenState === 'failed') return this.$t('partyGuest.listenFailed')
      return this.listening ? this.$t('partyGuest.listenStop') : this.$t('partyGuest.listen')
    },
  },
  watch: {
    'store.displaySong.id': {
      immediate: true,
      handler(id: string | undefined) {
        void this.store.loadWaveform(id ?? null)
      },
    },
  },
  methods: {
    toggle() {
      if (this.listening) this.store.stopListening()
      else this.store.startListening()
    },
    toggleMute() {
      if (this.store.volume > 0) {
        this.volumeBeforeMute = this.store.volume
        this.store.setVolume(0)
      } else {
        this.store.setVolume(this.volumeBeforeMute || 100)
      }
    },
    formatTime(seconds: number): string {
      const total = Math.max(0, Math.round(seconds))
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    },
  },
}
</script>

<style scoped>
/* The app's player bar, cut down: same chrome, height and hairline, and the
 * same three columns with the play button where the host has theirs. */
.guest-player-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 600px) minmax(0, 1fr);
  align-items: center;
  gap: 16px;
  height: var(--beacon-player-bar-height);
  padding: 0 16px;
  background: var(--beacon-chrome);
  border-top: 1px solid var(--beacon-hairline);
}

.guest-player-bar__song {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.guest-player-bar__labels {
  min-width: 0;
}

.guest-player-bar__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guest-player-bar__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

/* Filled, inverted-colour circle, as the host's play button
 * (CenterControls.vue). */
.guest-player-bar__play :deep(.v-icon) {
  color: rgb(var(--v-theme-background));
}

.guest-player-bar__seek {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 24px;
}

.guest-player-bar__time {
  flex: 0 0 40px;
  text-align: center;
}

.guest-player-bar__live {
  width: 100%;
  text-align: center;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.guest-player-bar__volume {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.guest-player-bar__slider.touch-volume-slider {
  flex: 0 1 120px;
}

/* On a phone, above the tab bar: the button and where the song is, as in
 * the app's own mini player (MobilePlayerBar.vue, 60px). */
.guest-player-bar.guest-player-bar--compact {
  grid-template-columns: minmax(0, 1fr);
  height: 60px;
  padding: 0 12px;
}

.guest-player-bar--compact .guest-player-bar__center {
  flex-direction: row;
  gap: 12px;
}
</style>
