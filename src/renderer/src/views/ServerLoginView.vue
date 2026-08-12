<template>
  <v-card min-width="440" max-width="480" class="login-card pa-6">
    <div class="login-header mb-6">
      <div class="login-icon-badge">
        <v-icon icon="mdi-lighthouse-on" size="26" color="primary" />
      </div>
      <div class="eyebrow-label mt-3">{{ $t('auth.welcomeBack') }}</div>
      <h1 class="display-title login-title">Beacon</h1>
      <div class="text-body-2 text-medium-emphasis mt-1">{{ $t('auth.chooseServer') }}</div>
    </div>

    <!-- Only the Subsonic/Navidrome tile is actually selectable — Jellyfin
     - and Plex are shown (real logos, real names) so the shape of what's
     - coming is visible, but "locked" the same way an unlit lighthouse
     - reads as "not this one yet", not "broken". -->
    <div class="server-type-grid mb-6">
      <button
        v-for="option in serverTypeOptions"
        :key="option.type"
        type="button"
        class="server-type-tile"
        :class="{
          'server-type-tile--selected': option.type === selectedServerType,
          'server-type-tile--locked': option.locked,
        }"
        :aria-pressed="option.type === selectedServerType"
        :aria-disabled="option.locked"
        :title="option.locked ? $t('auth.comingSoon') : undefined"
        @click="selectServerType(option)"
      >
        <span class="server-type-tile__icon">
          <component :is="option.icon" />
        </span>
        <span class="server-type-tile__name">{{ option.name }}</span>
        <v-icon
          v-if="option.locked"
          icon="mdi-lock-outline"
          size="12"
          class="server-type-tile__lock"
        />
      </button>
    </div>

    <v-card-text class="pa-0">
      <v-form @submit.prevent="submit">
        <v-text-field
          v-model="serverUrl"
          :label="$t('auth.serverUrl')"
          placeholder="https://navidrome.example.com"
          variant="solo-filled"
          class="mb-2"
        />
        <v-text-field
          v-model="username"
          :label="$t('auth.username')"
          variant="solo-filled"
          class="mb-2"
        />
        <v-text-field
          v-model="password"
          :label="$t('auth.password')"
          type="password"
          variant="solo-filled"
          class="mb-2"
        />

        <v-expansion-panels variant="accordion" class="mb-4">
          <v-expansion-panel :title="$t('auth.advanced')">
            <template #text>
              <v-text-field
                v-model="connectUrl"
                :label="$t('auth.connectBackendUrl')"
                variant="solo-filled"
              />
            </template>
          </v-expansion-panel>
        </v-expansion-panels>

        <v-alert v-if="authStore.loginError" type="error" variant="tonal" class="mb-4">
          {{ authStore.loginError }}
        </v-alert>

        <v-btn type="submit" color="primary" block :loading="submitting">
          {{ $t('auth.login') }}
        </v-btn>
      </v-form>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import NavidromeIcon from '@/components/auth/NavidromeIcon.vue'
import JellyfinIcon from '@/components/auth/JellyfinIcon.vue'
import PlexIcon from '@/components/auth/PlexIcon.vue'

export default {
  name: 'ServerLoginView',
  data() {
    return {
      serverUrl: '',
      username: '',
      password: '',
      connectUrl: 'http://localhost:9181',
      submitting: false,
      // Purely a visual choice for now — only 'subsonic' ever actually
      // submits (see submit() below), so this never needs to reach
      // stores/auth.ts. Real Jellyfin/Plex support is a separate,
      // considerably bigger project (full parallel library-browsing
      // clients, not just login) — see the plan this screen came out of.
      selectedServerType: 'subsonic',
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    // Computed (not a static data() array) so the labels stay correct if
    // the locale ever changes while this screen is up.
    serverTypeOptions() {
      return [
        {
          type: 'subsonic',
          name: this.$t('auth.serverTypeSubsonic'),
          icon: NavidromeIcon,
          locked: false,
        },
        {
          type: 'jellyfin',
          name: this.$t('auth.serverTypeJellyfin'),
          icon: JellyfinIcon,
          locked: true,
        },
        { type: 'plex', name: this.$t('auth.serverTypePlex'), icon: PlexIcon, locked: true },
      ]
    },
  },
  created() {
    this.serverUrl = this.authStore.serverUrl
    this.username = this.authStore.username
    this.connectUrl = this.authStore.connectUrl
  },
  methods: {
    selectServerType(option: { type: string; locked: boolean }) {
      if (option.locked) return
      this.selectedServerType = option.type
    },
    async submit() {
      this.submitting = true
      try {
        // login() resolves connectToken itself (see stores/auth.ts's
        // loadConnectDefaults) — the user never enters it.
        await this.authStore.login({
          serverUrl: this.serverUrl,
          username: this.username,
          password: this.password,
          connectUrl: this.connectUrl,
        })
        const redirect = this.$route.query.redirect
        this.$router.push(typeof redirect === 'string' ? redirect : '/')
      } catch {
        // authStore.loginError already holds the message, shown in the template.
      } finally {
        this.submitting = false
      }
    },
  },
}
</script>

<style scoped>
.login-card {
  background: rgba(18, 20, 28, 0.7);
  backdrop-filter: blur(20px);
}

.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.login-icon-badge {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(var(--v-theme-primary), 0.12);
  box-shadow: 0 0 24px rgba(var(--v-theme-primary), 0.25);
}

/* The one deliberate animated touch on this screen — a slow breathing
 * glow behind the badge, like the actual light the app is named after
 * sweeping past. Everything else here is static. */
.login-icon-badge::before {
  content: '';
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(245, 169, 78, 0.35), transparent 70%);
  animation: beacon-pulse 3.5s ease-in-out infinite;
}

@keyframes beacon-pulse {
  0%,
  100% {
    opacity: 0.5;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-icon-badge::before {
    animation: none;
  }
}

.login-title {
  font-size: 1.75rem;
}

.server-type-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.server-type-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.server-type-tile:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.server-type-tile:not(.server-type-tile--locked):hover {
  border-color: rgba(245, 169, 78, 0.35);
}

.server-type-tile__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  line-height: 1;
  filter: grayscale(1);
  opacity: 0.4;
  transition:
    filter 0.2s ease,
    opacity 0.2s ease;
}

.server-type-tile__name {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.5);
  transition: color 0.2s ease;
}

/* Selected = lit: the exact halo + edge-light language already used for
 * the active nav-rail item and the fullscreen player's art glow, applied
 * here to "this is the signal you're tuned to" instead. */
.server-type-tile--selected {
  border-color: rgba(245, 169, 78, 0.5);
  background: rgba(245, 169, 78, 0.08);
  box-shadow: 0 0 20px rgba(245, 169, 78, 0.18);
}

.server-type-tile--selected .server-type-tile__icon {
  filter: none;
  opacity: 1;
}

.server-type-tile--selected .server-type-tile__name {
  color: #fdf6ec;
  font-weight: 600;
}

.server-type-tile--selected::after {
  content: '';
  position: absolute;
  left: 22%;
  right: 22%;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 8px 1px rgba(245, 169, 78, 0.6);
}

/* Locked = unlit: quieter, not "broken" — no red, no strikethrough, just
 * the light not having reached that shore yet. */
.server-type-tile--locked {
  cursor: default;
}

.server-type-tile__lock {
  position: absolute;
  top: 6px;
  right: 6px;
  color: rgba(255, 255, 255, 0.3);
}
</style>
