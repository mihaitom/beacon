<template>
  <section class="settings-section">
    <h2 class="section-title">{{ $t('settings.account') }}</h2>
    <div class="beacon-panel">
      <div class="account-strip">
        <div class="account-badge">
          <NavidromeIcon v-if="authStore.serverType === 'subsonic'" />
          <PlexIcon v-else-if="authStore.serverType === 'plex'" />
          <JellyfinIcon v-else />
        </div>
        <div class="account-info">
          <p class="account-info__url">{{ serverUrl }}</p>
          <p class="account-info__user text-medium-emphasis">{{ username }}</p>
        </div>
        <v-btn variant="text" color="error" size="small" @click="logout">
          {{ $t('settings.logout') }}
        </v-btn>
      </div>

      <div class="setting">
        <v-select
          v-model="locale"
          :items="localeOptions"
          :label="$t('settings.language')"
          variant="solo-filled"
          hide-details
          @update:model-value="onLocaleChange"
        />
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import NavidromeIcon from '@/components/auth/NavidromeIcon.vue'
import JellyfinIcon from '@/components/auth/JellyfinIcon.vue'
import PlexIcon from '@/components/auth/PlexIcon.vue'
import { getLocale, type SupportedLocale } from '@/i18n'
import { setLocale } from '@/services/localeSetting'
/**
 * Who is signed in, where, and in which language. The badge echoes
 * ServerLoginView's lit server mark - the same signal that confirmed which
 * server you signed into now confirms who you are on it.
 */
export default {
  name: 'AccountSection',
  components: { NavidromeIcon, PlexIcon, JellyfinIcon },
  data() {
    return {
      serverUrl: '',
      username: '',
      locale: getLocale(),
    }
  },
  created() {
    this.serverUrl = this.authStore.serverUrl
    this.username = this.authStore.username
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    localeOptions() {
      return [
        { title: 'Deutsch', value: 'de' },
        { title: 'English', value: 'en' },
        { title: 'Español', value: 'es' },
        { title: 'Français', value: 'fr' },
        { title: 'Italiano', value: 'it' },
      ]
    },
  },
  methods: {
    onLocaleChange(value: SupportedLocale) {
      setLocale(value)
    },
    async logout() {
      await this.authStore.logout()
      this.$router.push('/login')
    },
  },
}
</script>

<style scoped>
/* Echoes ServerLoginView.vue's lit account badge — the same signal that
 * confirmed which server you signed into now confirms who you're signed in
 * as, a deliberate bookend rather than a plain read-only form field. No
 * border or surface of its own any more: the panel around it draws both,
 * and two nested hairlines read as a mistake. */
.account-strip {
  display: flex;
  align-items: center;
  gap: 14px;
}
.account-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 22px;
  flex-shrink: 0;
  background: rgba(var(--v-theme-primary), 0.12);
  box-shadow: 0 0 16px rgba(var(--v-theme-primary), 0.2);
}
.account-info {
  flex: 1;
  min-width: 0;
}
.account-info__url {
  font-weight: 600;
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-info__user {
  font-size: 0.8rem;
  margin-top: 2px;
}

/* One row on a phone too, the same shape as on the desktop - only
 * tighter. What gives when there is not enough width is the URL, which
 * already ellipsises (see .account-info__url); it is the one part of this
 * row that can lose its tail and still say what it says. Wrapping instead
 * put the button on a line of its own under the username, where it read
 * as a third line of account text rather than as an action. */
@media (max-width: 600px) {
  .account-strip {
    gap: 10px;
  }

  .account-strip > .v-btn {
    flex-shrink: 0;
  }
}
</style>
