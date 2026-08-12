<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="page-title">{{ $t('radio.title') }}</h1>
      <v-spacer />
      <v-btn prepend-icon="mdi-plus" variant="tonal" @click="createDialog = true">{{
        $t('radio.addStation')
      }}</v-btn>
    </div>

    <v-progress-circular v-if="libraryStore.loading" indeterminate class="mb-4" />

    <v-list v-if="libraryStore.radioStations.length" class="beacon-list">
      <v-list-item
        v-for="station in libraryStore.radioStations"
        :key="station.id"
        :title="station.name"
        :subtitle="station.streamUrl"
        @click="play(station)"
      >
        <template #prepend>
          <v-icon icon="mdi-radio" class="mr-3" />
        </template>
        <template #append>
          <v-btn icon="mdi-play" variant="text" @click.stop="play(station)" />
          <v-btn icon="mdi-delete-outline" variant="text" @click.stop="remove(station)" />
        </template>
      </v-list-item>
    </v-list>

    <v-alert v-else-if="!libraryStore.loading" type="info" variant="tonal">
      {{ $t('radio.noStationsYet') }}
    </v-alert>

    <v-dialog v-model="createDialog" max-width="420">
      <v-card>
        <v-card-title>{{ $t('radio.createTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="newName"
            :label="$t('common.name')"
            variant="solo-filled"
            class="mb-2"
          />
          <v-text-field
            v-model="newUrl"
            :label="$t('radio.streamUrl')"
            placeholder="https://..."
            variant="solo-filled"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" @click="create">{{ $t('common.add') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import type { RadioStation } from '@/types/library'

export default {
  name: 'RadioView',
  data() {
    return {
      createDialog: false,
      newName: '',
      newUrl: '',
    }
  },
  computed: {
    libraryStore() {
      return useLibraryStore()
    },
  },
  created() {
    this.libraryStore.fetchRadioStations()
  },
  methods: {
    play(station: RadioStation) {
      void usePlaybackStore().playRadioStation(station)
    },
    async create() {
      if (!this.newName.trim() || !this.newUrl.trim()) return
      await this.libraryStore.saveRadioStation(this.newName, this.newUrl)
      this.newName = ''
      this.newUrl = ''
      this.createDialog = false
    },
    async remove(station: RadioStation) {
      await this.libraryStore.deleteRadioStation(station.id)
    },
  },
}
</script>
