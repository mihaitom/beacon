<template>
  <div class="guest-queue">
    <p v-if="!upcoming.length" class="text-body-medium text-medium-emphasis guest-queue__empty">
      {{ $t('partyGuest.queueEmpty') }}
    </p>
    <guest-song-row
      v-for="(song, index) in upcoming"
      :key="`${index}-${song.id}`"
      :title="song.title"
      :subtitle="song.artist ?? ''"
      :cover="song.cover"
      :note="noteFor(song)"
    >
      <template v-if="song.request?.mine && song.request.id" #action>
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          :loading="withdrawing === song.request.id"
          :title="$t('partyGuest.withdraw')"
          :aria-label="$t('partyGuest.withdraw')"
          @click="withdraw(song.request.id)"
        />
      </template>
    </guest-song-row>
  </div>
</template>

<script lang="ts">
import { usePartyGuestStore } from '../store'
import type { UpcomingSong } from '../api'
import { guestErrorKey } from '../errors'
import GuestSongRow from './GuestSongRow.vue'

export default {
  name: 'GuestQueue',
  components: { GuestSongRow },
  emits: ['notify'],
  data() {
    return { withdrawing: null as string | null }
  },
  computed: {
    upcoming(): UpcomingSong[] {
      return usePartyGuestStore().snapshot?.upcoming ?? []
    },
  },
  methods: {
    noteFor(song: UpcomingSong): string | null {
      if (!song.request) return null
      return song.request.mine
        ? this.$t('partyGuest.yourWish')
        : this.$t('party.wishedBy', { name: song.request.name })
    },
    async withdraw(requestId: string) {
      this.withdrawing = requestId
      try {
        await usePartyGuestStore().withdraw(requestId)
      } catch (error) {
        this.$emit('notify', this.$t(guestErrorKey(error)))
      } finally {
        this.withdrawing = null
      }
    },
  },
}
</script>

<style scoped>
.guest-queue__empty {
  text-align: center;
  padding: 32px 16px;
}
</style>
