<template>
  <v-btn
    v-if="store.snapshot?.skip.enabled"
    prepend-icon="mdi-skip-next"
    :color="store.snapshot.skip.mine ? 'primary' : undefined"
    variant="text"
    density="comfortable"
    rounded="pill"
    :loading="skipping"
    :title="store.snapshot.skip.mine ? $t('partyGuest.voted') : $t('partyGuest.voteSkip')"
    :aria-label="store.snapshot.skip.mine ? $t('partyGuest.voted') : $t('partyGuest.voteSkip')"
    class="guest-skip"
    @click="toggleSkip"
  >
    {{ store.snapshot.skip.votes }}/{{ store.snapshot.skip.needed }}
  </v-btn>
</template>

<script lang="ts">
import { usePartyGuestStore } from '../store'
import { guestErrorKey } from '../errors'

/** The guest's one toolbar control: voting to skip the current song. Sits
 * in the shared toolbar's actions slot. */
export default {
  name: 'GuestSkipButton',
  emits: ['notify'],
  data() {
    return { skipping: false }
  },
  computed: {
    store() {
      return usePartyGuestStore()
    },
  },
  methods: {
    async toggleSkip() {
      this.skipping = true
      try {
        await this.store.toggleSkip()
      } catch (error) {
        this.$emit('notify', this.$t(guestErrorKey(error)))
      } finally {
        this.skipping = false
      }
    },
  },
}
</script>

<style scoped>
.guest-skip {
  font-variant-numeric: tabular-nums;
}
</style>
