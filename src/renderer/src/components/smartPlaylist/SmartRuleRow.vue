<template>
  <div
    class="smart-rule"
    :class="{ 'smart-rule--invalid': invalid, 'smart-rule--culprit': culprit }"
  >
    <smart-field-menu
      :field="rule.field"
      :readonly="readonly"
      @select="$emit('update', withField(rule, $event))"
    />
    <smart-operator-menu
      :operator="rule.operator"
      :operators="operators"
      :readonly="readonly"
      @select="$emit('update', withOperator(rule, $event))"
    />
    <smart-rule-value
      class="smart-rule__value"
      :rule="rule"
      :suggestions="suggestions"
      :playlists="playlists"
      :readonly="readonly"
      :invalid="invalid"
      @update="$emit('update', { ...rule, value: $event })"
    />
    <v-btn
      v-if="!readonly"
      icon="mdi-close"
      variant="text"
      size="small"
      class="smart-rule__remove"
      :title="$t('smartPlaylists.removeCondition')"
      :aria-label="$t('smartPlaylists.removeCondition')"
      @click="$emit('remove')"
    />
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  fieldDef,
  operatorsFor,
  withField,
  withOperator,
  type Operator,
  type RuleNode,
} from '@/services/navidrome/smartRules'
import type { Suggestion } from '@/services/navidrome/suggestions'
import type { Playlist } from '@/types/library'
import SmartFieldMenu from './SmartFieldMenu.vue'
import SmartOperatorMenu from './SmartOperatorMenu.vue'
import SmartRuleValue from './SmartRuleValue.vue'

/** One condition, read left to right as a sentence: field, how, what. */
export default {
  name: 'SmartRuleRow',
  components: { SmartFieldMenu, SmartOperatorMenu, SmartRuleValue },
  props: {
    rule: { type: Object as PropType<RuleNode>, required: true },
    suggestions: { type: Array as PropType<Suggestion[]>, default: () => [] },
    playlists: { type: Array as PropType<Playlist[]>, default: () => [] },
    readonly: { type: Boolean, default: false },
    /** Not filled in enough to save - shown once a save was tried. */
    invalid: { type: Boolean, default: false },
    /** The rule that on its own leaves the preview empty. */
    culprit: { type: Boolean, default: false },
  },
  emits: {
    update: (rule: RuleNode) => rule.type === 'rule',
    remove: () => true,
  },
  computed: {
    operators(): Operator[] {
      const field = fieldDef(this.rule.field)
      return field ? operatorsFor(field) : [this.rule.operator]
    },
  },
  methods: { withField, withOperator },
}
</script>

<style scoped>
.smart-rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  padding: 6px 6px 6px 4px;
  border-radius: 8px;
  border: 1px solid transparent;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}

.smart-rule:hover {
  background: rgba(255, 255, 255, 0.02);
}

/* The value takes what is left of the line and wraps under the field and
 * operator on a narrow screen rather than squeezing them. */
.smart-rule__value {
  flex: 1 1 260px;
}

.smart-rule__remove {
  margin-left: auto;
  opacity: 0.55;
  transition: opacity 0.15s;
}

.smart-rule:hover .smart-rule__remove,
.smart-rule__remove:focus-visible {
  opacity: 1;
}

/* Red for "fix this before saving", amber for "this is why the preview is
 * empty" - the second is information, not an error. */
.smart-rule--invalid {
  border-color: rgba(var(--v-theme-error), 0.6);
}

.smart-rule--culprit {
  border-color: rgba(var(--v-theme-primary), 0.55);
  background: rgba(var(--v-theme-primary), 0.06);
}
</style>
