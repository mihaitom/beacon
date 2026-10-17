<template>
  <div class="smart-value">
    <template v-if="shape === 'text'">
      <v-combobox
        :model-value="textValue"
        :items="suggestions"
        item-title="value"
        item-value="value"
        :return-object="false"
        :label="$t('smartPlaylists.valueLabel')"
        :readonly="readonly"
        :error="invalid"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        single-line
        class="smart-value__text"
        @update:model-value="emitText"
      >
        <template #item="{ props: itemProps, item }">
          <v-list-item v-bind="itemProps" :title="item.value">
            <template v-if="item.count !== null" #append>
              <span class="text-body-small text-medium-emphasis smart-value__count">
                {{ $n(item.count) }}
              </span>
            </template>
          </v-list-item>
        </template>
      </v-combobox>
    </template>

    <template v-else-if="shape === 'number' || shape === 'range'">
      <template v-for="(part, index) in numberParts" :key="index">
        <span v-if="index === 1" class="smart-value__dash">–</span>
        <v-rating
          v-if="field.key === 'rating'"
          :model-value="part ?? 0"
          length="5"
          density="compact"
          active-color="primary"
          color="medium-emphasis"
          hover
          :readonly="readonly"
          class="smart-value__rating"
          @update:model-value="setNumber(index, Number($event))"
        />
        <v-text-field
          v-else
          :model-value="displayNumber(part)"
          type="number"
          min="0"
          :suffix="unitSuffix"
          :readonly="readonly"
          :error="invalid && part === null"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          single-line
          class="smart-value__number"
          @update:model-value="setNumber(index, parseNumber($event))"
        />
      </template>
    </template>

    <template v-else-if="shape === 'days'">
      <v-text-field
        :model-value="dayAmount"
        type="number"
        min="0"
        :readonly="readonly"
        :error="invalid"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        single-line
        class="smart-value__number"
        @update:model-value="setDayAmount(parseNumber($event))"
      />
      <v-select
        :model-value="dayUnit"
        :items="dayUnitItems"
        :readonly="readonly"
        variant="solo-filled"
        density="compact"
        flat
        hide-details
        class="smart-value__unit"
        @update:model-value="setDayUnit"
      />
    </template>

    <v-menu
      v-else-if="shape === 'date'"
      v-model="dateMenu"
      :close-on-content-click="false"
      :disabled="readonly"
      location="bottom start"
    >
      <template #activator="{ props: menuProps }">
        <v-text-field
          v-bind="menuProps"
          :model-value="dateLabel"
          :placeholder="$t('smartPlaylists.chooseDate')"
          prepend-inner-icon="mdi-calendar-blank-outline"
          readonly
          :error="invalid"
          variant="solo-filled"
          density="compact"
          flat
          hide-details
          single-line
          class="smart-value__date"
        />
      </template>
      <!-- In the app's language: Vuetify's own locale stays English
       - app-wide, so the picker gets the matching one here. -->
      <v-locale-provider :locale="$i18n.locale" :messages="vuetifyMessages">
        <v-date-picker
          :model-value="dateValue"
          color="primary"
          hide-header
          show-adjacent-months
          @update:model-value="pickDate"
        />
      </v-locale-provider>
    </v-menu>

    <v-btn-toggle
      v-else-if="shape === 'boolean'"
      :model-value="value"
      mandatory
      :disabled="readonly"
      density="compact"
      color="primary"
      variant="outlined"
      divided
      class="smart-value__toggle"
      @update:model-value="$emit('update', $event)"
    >
      <v-btn :value="true">{{ $t('smartPlaylists.yes') }}</v-btn>
      <v-btn :value="false">{{ $t('smartPlaylists.no') }}</v-btn>
    </v-btn-toggle>

    <v-autocomplete
      v-else-if="shape === 'playlist'"
      :model-value="value"
      :items="playlists"
      item-title="name"
      item-value="id"
      :label="$t('smartPlaylists.choosePlaylist')"
      :readonly="readonly"
      :error="invalid"
      variant="solo-filled"
      density="compact"
      flat
      hide-details
      single-line
      class="smart-value__playlist"
      @update:model-value="$emit('update', $event)"
    >
      <template #item="{ props: itemProps, item }">
        <v-list-item v-bind="itemProps">
          <template #prepend>
            <cover-art
              :cover-art-id="item.coverArtId"
              :size="32"
              fallback-icon="mdi-playlist-music"
              class="smart-value__playlist-cover"
            />
          </template>
        </v-list-item>
      </template>
    </v-autocomplete>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import CoverArt from '@/components/library/CoverArt.vue'
import { de, en, es, fr, it } from 'vuetify/locale'
import { DAYS_PER, splitDays, type DayUnit } from '@/services/navidrome/dayUnits'
import { dateToDay, dayToDate } from '@/services/navidrome/dates'
import {
  fieldDef,
  valueShape,
  type FieldDef,
  type RuleNode,
  type RuleValue,
  type ValueShape,
} from '@/services/navidrome/smartRules'
import type { Suggestion } from '@/services/navidrome/suggestions'
import type { Playlist } from '@/types/library'

/** Fields whose numbers the editor shows in another unit than Navidrome
 * stores: a duration is seconds there and minutes to anyone typing it. */
const SCALE: Record<string, number> = { duration: 60 }

/**
 * The value of a rule, in the control its kind deserves: stars for a
 * rating, yes/no for a flag, a number and a unit for "in the last", a
 * playlist picker with covers, and for text the values the library really
 * holds - while still taking anything typed.
 */
export default {
  name: 'SmartRuleValue',
  components: { CoverArt },
  props: {
    rule: { type: Object as PropType<RuleNode>, required: true },
    suggestions: { type: Array as PropType<Suggestion[]>, default: () => [] },
    playlists: { type: Array as PropType<Playlist[]>, default: () => [] },
    readonly: { type: Boolean, default: false },
    invalid: { type: Boolean, default: false },
  },
  emits: {
    update: (value: RuleValue) => value !== undefined,
  },
  data() {
    return {
      // Held here rather than derived from the days alone: someone who
      // picked "weeks" and typed 3 should keep seeing weeks, not 21 days.
      chosenDayUnit: null as DayUnit | null,
      dateMenu: false,
      vuetifyMessages: { de, en, es, fr, it },
    }
  },
  computed: {
    field(): FieldDef {
      return fieldDef(this.rule.field)!
    },
    shape(): ValueShape {
      return valueShape(this.field, this.rule.operator)
    },
    value(): RuleValue {
      return this.rule.value
    },
    textValue(): string {
      return typeof this.value === 'string' ? this.value : ''
    },
    numberParts(): (number | null)[] {
      if (this.shape === 'range') {
        return Array.isArray(this.value) ? [...this.value] : [null, null]
      }
      return [typeof this.value === 'number' ? this.value : null]
    },
    scale(): number {
      return SCALE[this.field.key] ?? 1
    },
    unitSuffix(): string | undefined {
      return this.field.key === 'duration' ? this.$t('smartPlaylists.units.minutes') : undefined
    },
    dayUnit(): DayUnit {
      if (this.chosenDayUnit) return this.chosenDayUnit
      return typeof this.value === 'number' ? splitDays(this.value).unit : 'days'
    },
    dayAmount(): number | null {
      if (typeof this.value !== 'number') return null
      return this.value / DAYS_PER[this.dayUnit]
    },
    dateValue(): Date | null {
      return typeof this.value === 'string' ? dayToDate(this.value) : null
    },
    /** The day as people write it in the app's language. */
    dateLabel(): string {
      if (!this.dateValue) return ''
      return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: 'medium' }).format(
        this.dateValue,
      )
    },
    dayUnitItems(): { title: string; value: DayUnit }[] {
      return (Object.keys(DAYS_PER) as DayUnit[]).map((unit) => ({
        title: this.$t(`smartPlaylists.units.${unit}`),
        value: unit,
      }))
    },
  },
  methods: {
    emitText(next: unknown): void {
      this.$emit('update', typeof next === 'string' ? next : '')
    },
    parseNumber(raw: unknown): number | null {
      if (raw === '' || raw === null || raw === undefined) return null
      const number = Number(raw)
      return Number.isFinite(number) ? number : null
    },
    displayNumber(stored: number | null): string {
      return stored === null ? '' : String(stored / this.scale)
    },
    setNumber(index: number, shown: number | null): void {
      const stored = shown === null ? null : Math.round(shown * this.scale)
      if (this.shape === 'range') {
        const next = [...this.numberParts] as [number | null, number | null]
        next[index] = stored
        this.$emit('update', next)
      } else {
        this.$emit('update', stored)
      }
    },
    setDayAmount(amount: number | null): void {
      this.chosenDayUnit = this.dayUnit
      this.$emit('update', amount === null ? null : Math.round(amount * DAYS_PER[this.dayUnit]))
    },
    pickDate(picked: unknown): void {
      if (!(picked instanceof Date)) return
      this.$emit('update', dateToDay(picked))
      this.dateMenu = false
    },
    setDayUnit(unit: DayUnit): void {
      const amount = this.dayAmount
      this.chosenDayUnit = unit
      if (amount !== null) this.$emit('update', Math.round(amount * DAYS_PER[unit]))
    },
  },
}
</script>

<style scoped>
.smart-value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* Wide enough for a long artist or album name without taking the whole
 * row from the field and operator before it. */
.smart-value__text,
.smart-value__playlist {
  flex: 1 1 220px;
  min-width: 180px;
}

/* A year, a count, a number of days: four or five digits plus a suffix. */
.smart-value__number {
  flex: 0 0 auto;
  width: 112px;
}

.smart-value__unit {
  flex: 0 0 auto;
  width: 140px;
}

.smart-value__date {
  flex: 0 0 auto;
  width: 180px;
}

.smart-value__dash {
  opacity: 0.6;
}

.smart-value__count {
  font-variant-numeric: tabular-nums;
}

/* Yes/no read as words in a sentence, not as shouted button labels. */
.smart-value__toggle :deep(.v-btn) {
  text-transform: none;
  letter-spacing: normal;
}

.smart-value__playlist-cover {
  margin-right: 12px;
  border-radius: 4px;
}
</style>
