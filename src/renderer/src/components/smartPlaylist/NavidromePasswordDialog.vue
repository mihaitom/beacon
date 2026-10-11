<template>
  <v-dialog v-model="visible" max-width="420" persistent>
    <v-card>
      <v-card-title>{{ $t('smartPlaylists.password.title') }}</v-card-title>
      <v-card-text class="password-dialog__body">
        <p class="text-body-medium text-medium-emphasis password-dialog__text">
          {{ $t('smartPlaylists.password.text') }}
        </p>
        <v-text-field
          v-model="password"
          type="password"
          autocomplete="current-password"
          :label="$t('smartPlaylists.password.label')"
          :error-messages="rejected ? [$t('smartPlaylists.password.rejected')] : []"
          variant="solo-filled"
          autofocus
          @keyup.enter="submit"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="finish(false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :disabled="!password" :loading="checking" @click="submit">
          {{ $t('smartPlaylists.password.submit') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { NavidromePasswordRejected, loginToNavidrome } from '@/services/navidrome/client'

/**
 * Asks for the Navidrome password when the stored one is missing or no
 * longer works (see services/navidrome/client.ts). `ask()` resolves true
 * once Navidrome has accepted one, false when the user gives up. The
 * password goes to connect, which keeps only the token it gets for it.
 */
export default {
  name: 'NavidromePasswordDialog',
  data() {
    return {
      visible: false,
      password: '',
      rejected: false,
      checking: false,
      resolve: null as ((ok: boolean) => void) | null,
    }
  },
  methods: {
    ask(): Promise<boolean> {
      this.password = ''
      this.rejected = false
      this.visible = true
      return new Promise((resolve) => {
        this.resolve = resolve
      })
    },
    async submit(): Promise<void> {
      if (!this.password || this.checking) return
      this.checking = true
      this.rejected = false
      try {
        await loginToNavidrome(this.password)
        this.finish(true)
      } catch (error) {
        if (error instanceof NavidromePasswordRejected) this.rejected = true
        else throw error
      } finally {
        this.checking = false
      }
    },
    finish(ok: boolean): void {
      this.visible = false
      this.password = ''
      this.resolve?.(ok)
      this.resolve = null
    },
  },
}
</script>

<style scoped>
.password-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.password-dialog__text {
  margin: 0;
}
</style>
