<template>
  <v-btn
    :icon="wished ? 'mdi-check' : 'mdi-plus'"
    size="small"
    :variant="wished ? 'text' : 'tonal'"
    :color="wished ? 'primary' : undefined"
    :disabled="!wished && store.wishesLeft === 0"
    :loading="busy"
    :title="$t('partyGuest.wish')"
    :aria-label="$t('partyGuest.wish')"
    @click="wish"
  />
</template>

<script lang="ts">
import type { GuestSong } from '../api'
import { usePartyGuestStore } from '../store'
import { guestErrorKey } from '../errors'

export default {
  name: 'WishButton',
  props: {
    song: { type: Object as () => GuestSong, required: true },
  },
  emits: ['notify'],
  data() {
    return { busy: false }
  },
  computed: {
    store() {
      return usePartyGuestStore()
    },
    wished(): boolean {
      return this.store.isWished(this.song.id)
    },
  },
  methods: {
    async wish() {
      if (this.wished) return
      this.busy = true
      try {
        await this.store.wish(this.song)
        this.$emit('notify', this.$t('partyGuest.wished'))
      } catch (error) {
        this.$emit('notify', this.$t(guestErrorKey(error)))
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
