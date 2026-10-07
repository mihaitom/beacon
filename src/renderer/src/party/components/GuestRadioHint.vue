<template>
  <div class="guest-radio-hint">
    <v-icon icon="mdi-radio" color="primary" size="40" />
    <p class="text-title-medium">{{ $t('partyGuest.radioTitle') }}</p>
    <p class="text-body-medium text-medium-emphasis">{{ $t('partyGuest.radioText') }}</p>
  </div>
</template>

<script lang="ts">
/** In place of what's next and the search while a station plays: a wish
 * goes into the queue, and a station has none. */
export default {
  name: 'GuestRadioHint',
}
</script>

<style scoped>
.guest-radio-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
  text-align: center;
}

.guest-radio-hint p {
  margin: 0;
}
</style>
