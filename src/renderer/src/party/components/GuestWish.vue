<template>
  <div class="guest-wish">
    <div class="guest-wish__search">
      <v-text-field
        v-model="query"
        :placeholder="$t('partyGuest.search')"
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="comfortable"
        maxlength="100"
        clearable
        hide-details
        :loading="store.search.loading"
      />
      <p class="text-body-small text-medium-emphasis guest-wish__quota">{{ quotaText }}</p>
    </div>

    <template v-if="store.search.album">
      <v-btn
        variant="text"
        prepend-icon="mdi-chevron-left"
        class="guest-wish__back"
        @click="store.search.album = null"
      >
        {{ $t('partyGuest.back') }}
      </v-btn>
      <h3 class="eyebrow-label panel-title">{{ store.search.album.album.name }}</h3>
      <guest-song-row
        v-for="song in store.search.album.songs"
        :key="song.id"
        :title="song.title"
        :subtitle="song.artist ?? ''"
        :cover="song.cover"
      >
        <template #action>
          <wish-button :song="song" @notify="$emit('notify', $event)" />
        </template>
      </guest-song-row>
    </template>

    <template v-else-if="store.search.query">
      <p
        v-if="!store.search.loading && !store.search.songs.length && !store.search.albums.length"
        class="text-body-medium text-medium-emphasis guest-wish__hint"
      >
        {{ $t('partyGuest.noResults') }}
      </p>
      <template v-if="store.search.songs.length">
        <h3 class="eyebrow-label panel-title">{{ $t('partyGuest.songs') }}</h3>
        <guest-song-row
          v-for="song in store.search.songs"
          :key="song.id"
          :title="song.title"
          :subtitle="song.artist ?? ''"
          :cover="song.cover"
        >
          <template #action>
            <wish-button :song="song" @notify="$emit('notify', $event)" />
          </template>
        </guest-song-row>
      </template>
      <template v-if="store.search.albums.length">
        <h3 class="eyebrow-label panel-title guest-wish__section">
          {{ $t('partyGuest.albums') }}
        </h3>
        <guest-song-row
          v-for="album in store.search.albums"
          :key="album.id"
          :title="album.name"
          :subtitle="album.artist ?? ''"
          :cover="album.cover"
          tappable
          @click="openAlbum(album.id)"
        />
      </template>
    </template>

    <p v-else class="text-body-medium text-medium-emphasis guest-wish__hint">
      {{ $t('partyGuest.searchHint') }}
    </p>
  </div>
</template>

<script lang="ts">
import { usePartyGuestStore } from '../store'
import { guestErrorKey } from '../errors'
import GuestSongRow from './GuestSongRow.vue'
import WishButton from './WishButton.vue'

const SEARCH_DEBOUNCE_MS = 300

export default {
  name: 'GuestWish',
  components: { GuestSongRow, WishButton },
  emits: ['notify'],
  data() {
    return {
      query: usePartyGuestStore().search.query,
      timer: null as ReturnType<typeof setTimeout> | null,
    }
  },
  computed: {
    store() {
      return usePartyGuestStore()
    },
    quotaText(): string {
      const left = this.store.wishesLeft
      if (left === 0) return this.$t('partyGuest.quotaNone')
      return this.$t('partyGuest.quota', {
        left,
        max: this.store.snapshot?.limits.max_pending ?? 0,
      })
    },
  },
  watch: {
    query(value: string | null) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        void this.store
          .runSearch((value ?? '').trim())
          .catch((error) => this.$emit('notify', this.$t(guestErrorKey(error))))
      }, SEARCH_DEBOUNCE_MS)
    },
  },
  beforeUnmount() {
    if (this.timer) clearTimeout(this.timer)
  },
  methods: {
    async openAlbum(id: string) {
      try {
        await this.store.openAlbum(id)
      } catch (error) {
        this.$emit('notify', this.$t(guestErrorKey(error)))
      }
    },
  },
}
</script>

<style scoped>
/* Stays put while the results scroll under it. */
.guest-wish__search {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-bottom: 12px;
  background: rgb(var(--v-theme-background));
}

.guest-wish__quota {
  margin: 6px 4px 0;
}

.guest-wish__hint {
  text-align: center;
  padding: 32px 16px;
}

.guest-wish__section {
  margin-top: 18px;
}

.guest-wish__back {
  margin-bottom: 8px;
}
</style>
