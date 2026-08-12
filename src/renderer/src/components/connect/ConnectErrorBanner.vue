<template>
  <v-alert :type="alertType" variant="tonal" density="compact" class="mb-2">
    <div class="d-flex align-center">
      <span>{{ message }}</span>
      <v-spacer />
      <v-btn v-if="variant === 'api-unreachable'" size="small" variant="text" @click="$emit('retry')">
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
