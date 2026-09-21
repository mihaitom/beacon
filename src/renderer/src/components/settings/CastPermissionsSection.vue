<template>
  <!-- Docker/web only: the desktop build spawns a one-user connect, so
     - there is nobody to restrict and this must never appear there (see
     - docs/cast-permissions.md). window.api is the same web-build test
     - useIsMobileWeb.ts uses. -->
  <section v-if="visible" class="settings-section">
    <h2 class="section-title">{{ $t('settings.castPermissionsTitle') }}</h2>
    <div class="beacon-panel">
      <div class="setting">
        <p class="setting__description">{{ $t('settings.castPermissionsHint') }}</p>
        <p v-if="loadFailed" class="setting__hint">
          {{ $t('settings.castPermissionsLoadFailed') }}
        </p>
        <template v-else>
          <!-- One control, not two: "who may cast" already says everything
             - the mode/unlisted-default pair said between them. The list
             - only matters for the two middle choices, so it is hidden for
             - "everyone"/"nobody" where it has no effect. -->
          <v-select
            v-model="policy"
            :items="policyItems"
            item-title="title"
            item-value="value"
            :label="$t('settings.castPermissionsPolicy')"
            variant="solo-filled"
            hide-details
          />
          <p class="setting__hint">{{ effectHint }}</p>

          <template v-if="listApplies">
            <v-select
              v-model="accounts"
              :items="suggestedAccounts"
              :label="accountLabel"
              variant="solo-filled"
              multiple
              chips
              closable-chips
              hide-details
            />
            <!-- Shown whenever the server cannot hand over its full account
               - list (Navidrome), so an account missing from the picker is
               - understood rather than looked for. -->
            <p v-if="!listsUsers" class="setting__hint">
              {{ $t('settings.castPermissionsNoUsers') }}
            </p>
          </template>
        </template>
        <div class="setting__control-row">
          <v-spacer />
          <v-btn color="primary" :loading="saving" :disabled="saving || loadFailed" @click="save">
            {{ $t('settings.castPermissionsSave') }}
          </v-btn>
        </div>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { useAuthStore } from '@/stores/auth'
import {
  getCastPermissions,
  setCastPermissions,
  type CastPermissionMode,
} from '@/services/connect/castPermissions'

type CastPolicy = 'everyone' | 'allowlist' | 'blocklist' | 'nobody'

/** The four states the (mode, default_allow) pair can be in, as one
 * choice. Only these four exist, which is why they are offered directly
 * rather than as two switches that mostly repeat each other. */
function toPolicy(mode: CastPermissionMode, defaultAllow: boolean): CastPolicy {
  if (mode === 'blocklist') return defaultAllow ? 'blocklist' : 'nobody'
  return defaultAllow ? 'everyone' : 'allowlist'
}

function fromPolicy(policy: CastPolicy): {
  mode: CastPermissionMode
  default_allow: boolean
} {
  switch (policy) {
    case 'everyone':
      return { mode: 'allowlist', default_allow: true }
    case 'blocklist':
      return { mode: 'blocklist', default_allow: true }
    case 'nobody':
      return { mode: 'blocklist', default_allow: false }
    default:
      return { mode: 'allowlist', default_allow: false }
  }
}

/**
 * The server admin's cast policy: who may cast to speakers at all. See
 * docs/cast-permissions.md. Visible only in the web/Docker build, for a
 * Subsonic/Jellyfin admin (capabilities.ts's castPermissions handles the
 * server/account half; window.api the build half).
 *
 * The picker's accounts come from the backend (see
 * routes/cast_permissions.py): every account that has signed in to this
 * Beacon, plus the server's own list where it offers one (Jellyfin). There
 * is no typing.
 */
export default {
  name: 'CastPermissionsSection',
  data() {
    return {
      accounts: [] as string[],
      policy: 'everyone' as CastPolicy,
      suggestedAccounts: [] as string[],
      listsUsers: false,
      saving: false,
      loadFailed: false,
    }
  },
  computed: {
    authStore() {
      return useAuthStore()
    },
    visible(): boolean {
      return !window.api && this.authStore.capabilities.castPermissions
    },
    policyItems(): { value: CastPolicy; title: string }[] {
      return [
        { value: 'everyone', title: this.$t('settings.castPermissionsPolicyEveryone') },
        { value: 'allowlist', title: this.$t('settings.castPermissionsPolicyAllowlist') },
        { value: 'blocklist', title: this.$t('settings.castPermissionsPolicyBlocklist') },
        { value: 'nobody', title: this.$t('settings.castPermissionsPolicyNobody') },
      ]
    },
    /** Whether the account list has any effect for the chosen policy — it
     * does not for "everyone" or "nobody". */
    listApplies(): boolean {
      return this.policy === 'allowlist' || this.policy === 'blocklist'
    },
    accountLabel(): string {
      return this.policy === 'allowlist'
        ? this.$t('settings.castPermissionsAccountAllow')
        : this.$t('settings.castPermissionsAccountBlock')
    },
    effectHint(): string {
      if (this.policy === 'everyone') return this.$t('settings.castPermissionsEffectEveryone')
      if (this.policy === 'blocklist') {
        return this.$t('settings.castPermissionsEffectAllExceptListed')
      }
      if (this.policy === 'nobody') return this.$t('settings.castPermissionsEffectNobody')
      return this.accounts.length
        ? this.$t('settings.castPermissionsEffectOnlyListed')
        : this.$t('settings.castPermissionsEffectNobody')
    },
  },
  created() {
    if (this.visible) void this.load()
  },
  methods: {
    async load(): Promise<void> {
      try {
        const stored = await getCastPermissions()
        this.accounts = [...stored.accounts]
        this.policy = toPolicy(stored.mode, stored.default_allow)
        this.suggestedAccounts = [...stored.suggested_accounts]
        this.listsUsers = stored.lists_users
      } catch (error) {
        this.loadFailed = true
        console.error('[settings] Failed to load casting permissions:', error)
      }
    },
    async save(): Promise<void> {
      this.saving = true
      try {
        const saved = await setCastPermissions({
          accounts: this.accounts,
          ...fromPolicy(this.policy),
        })
        this.accounts = [...saved.accounts]
        this.policy = toPolicy(saved.mode, saved.default_allow)
        this.$emitter.emit('toast', {
          level: 'success',
          title: this.$t('settings.castPermissionsTitle'),
          message: this.$t('settings.castPermissionsSaved'),
        })
      } catch (error) {
        this.$emitter.emit('toast', {
          level: 'error',
          title: this.$t('settings.castPermissionsTitle'),
          message: this.$t('settings.castPermissionsSaveFailed'),
        })
        console.error('[settings] Failed to save casting permissions:', error)
      } finally {
        this.saving = false
      }
    },
  },
}
</script>
