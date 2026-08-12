<template>
  <v-card min-width="420" max-width="480" class="pa-4">
    <div class="login-header mb-6">
      <div class="login-icon-badge">
        <v-icon icon="mdi-lighthouse-on" size="26" color="primary" />
      </div>
      <div class="eyebrow-label mt-3">{{ $t('auth.welcomeBack') }}</div>
      <h1 class="display-title login-title">Beacon</h1>
      <div class="text-body-2 text-medium-emphasis mt-1">{{ $t('auth.connectToNavidrome') }}</div>
    </div>

    <v-card-text>
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

export default {
  name: 'ServerLoginView',
  data() {
    return {
      serverUrl: '',
      username: '',
      password: '',
      connectUrl: 'http://localhost:9181',
      submitting: false,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
  },
  created() {
    this.serverUrl = this.authStore.serverUrl
    this.username = this.authStore.username
    this.connectUrl = this.authStore.connectUrl
  },
  methods: {
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
.login-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.login-icon-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(var(--v-theme-primary), 0.12);
  box-shadow: 0 0 24px rgba(var(--v-theme-primary), 0.25);
}

.login-title {
  font-size: 1.75rem;
}
</style>
