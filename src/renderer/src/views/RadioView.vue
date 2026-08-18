<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="page-title">{{ $t('radio.title') }}</h1>
      <v-spacer />
      <v-btn prepend-icon="mdi-plus" variant="tonal" @click="openCreate">{{
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
          <!-- CoverArt.vue's imageUrl prop already does exactly what a
           - station favicon needs: try the given URL, fall back to
           - fallback-icon on load failure, and — the actual reason to use
           - it here rather than a hand-rolled <img>+<v-icon> pair — always
           - render the *same* v-avatar-wrapped markup either way. A bare
           - <img> vs a bare <v-icon> directly in VListItem's prepend slot
           - used to get different spacing before the title text, since
           - VListItem sizes that slot differently depending on what kind
           - of content it recognizes inside it. -->
          <cover-art
            :image-url="station.homePageUrl ? faviconUrl(station.homePageUrl, 32) : null"
            :size="24"
            rounded
            fallback-icon="mdi-radio"
            class="mr-3"
          />
        </template>
        <template #append>
          <v-btn icon="mdi-play" variant="text" @click.stop="play(station)" />
          <v-btn icon="mdi-pencil-outline" variant="text" @click.stop="openEdit(station)" />
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
            v-model="formName"
            :label="$t('common.name')"
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formStreamUrl"
            :label="$t('radio.streamUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formHomePageUrl"
            :label="$t('radio.homePageUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" @click="create">{{ $t('common.add') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="editDialog" max-width="420">
      <v-card>
        <v-card-title>{{ $t('radio.editTitle') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="formName"
            :label="$t('common.name')"
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formStreamUrl"
            :label="$t('radio.streamUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
            class="mb-2"
          />
          <v-text-field
            v-model="formHomePageUrl"
            :label="$t('radio.homePageUrl')"
            placeholder="https://..."
            variant="solo-filled"
            clearable
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="editDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" @click="saveEdit">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { useLibraryStore } from '@/stores/library'
import { usePlaybackStore } from '@/stores/playback'
import { useAuthStore } from '@/stores/auth'
import { radioFaviconUrl } from '@/services/connect/radio'
import CoverArt from '@/components/library/CoverArt.vue'
import type { RadioStation } from '@/types/library'

export default {
  name: 'RadioView',
  components: { CoverArt },
  data() {
    return {
      createDialog: false,
      editDialog: false,
      editingId: null as string | null,
      formName: '',
      formStreamUrl: '',
      formHomePageUrl: '',
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
    faviconUrl(homePageUrl: string, minSize = 0): string {
      const auth = useAuthStore()
      return radioFaviconUrl(auth.apiUrl, auth.connectToken, homePageUrl, minSize)
    },
    play(station: RadioStation) {
      void usePlaybackStore().playRadioStation(station)
    },
    openCreate() {
      this.formName = ''
      this.formStreamUrl = ''
      this.formHomePageUrl = ''
      this.createDialog = true
    },
    async create() {
      if (!this.formName.trim() || !this.formStreamUrl.trim()) return
      await this.libraryStore.saveRadioStation(
        this.formName.trim(),
        this.formStreamUrl.trim(),
        this.formHomePageUrl.trim(),
      )
      this.createDialog = false
    },
    openEdit(station: RadioStation) {
      this.editingId = station.id
      this.formName = station.name
      this.formStreamUrl = station.streamUrl
      this.formHomePageUrl = station.homePageUrl ?? ''
      this.editDialog = true
    },
    async saveEdit() {
      if (!this.editingId || !this.formName.trim() || !this.formStreamUrl.trim()) return
      await this.libraryStore.updateRadioStation(
        this.editingId,
        this.formName.trim(),
        this.formStreamUrl.trim(),
        this.formHomePageUrl.trim(),
      )
      this.editDialog = false
    },
    async remove(station: RadioStation) {
      await this.libraryStore.deleteRadioStation(station.id)
    },
  },
}
</script>
