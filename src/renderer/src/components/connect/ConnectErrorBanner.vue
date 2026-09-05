<template>
  <v-alert :type="alertType" variant="tonal" density="compact" class="connect-error-banner">
    <div class="connect-error-banner__row">
      <span>{{ message }}</span>
      <v-spacer />
      <v-btn
        v-if="variant === 'api-unreachable'"
        size="small"
        variant="text"
        @click="$emit('retry')"
      >
        {{ $t('common.retry') }}
      </v-btn>
    </div>
  </v-alert>
</template>

<script lang="ts">
export default {
  name: 'ConnectErrorBanner',
  props: {
    variant: {
      type: String,
      required: true,
    },
  },
  emits: ['retry'],
  computed: {
    alertType() {
      return this.variant === 'ffmpeg-missing' ? 'warning' : 'error'
    },
    message() {
      switch (this.variant) {
        case 'api-unreachable':
          return this.$t('connect.apiUnreachable')
        case 'auth-error':
          return this.$t('connect.authError')
        case 'ffmpeg-missing':
          return this.$t('connect.ffmpegMissing')
        default:
          return this.$t('connect.unknownError')
      }
    },
  },
}
</script>

<style scoped>
/* The message and the retry button on one line, with a v-spacer between
 * them pushing the button to the far end. */
.connect-error-banner__row {
  display: flex;
  align-items: center;
}

.connect-error-banner {
  margin-bottom: 8px;
}
</style>
