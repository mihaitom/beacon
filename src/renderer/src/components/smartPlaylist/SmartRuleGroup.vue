<template>
  <div class="smart-group" :class="{ 'smart-group--invalid': invalid }">
    <div class="smart-group__head">
      <span class="smart-group__words">{{ $t('smartPlaylists.groupPrefix') }}</span>
      <smart-conjunction-toggle
        :model-value="group.conjunction"
        :readonly="readonly"
        @update:model-value="$emit('update', { ...group, conjunction: $event })"
      />
      <span class="smart-group__words">{{ $t('smartPlaylists.groupSuffix') }}</span>
      <v-btn
        v-if="!readonly"
        icon="mdi-close"
        variant="text"
        size="small"
        class="smart-group__remove"
        :title="$t('smartPlaylists.removeGroup')"
        :aria-label="$t('smartPlaylists.removeGroup')"
        @click="$emit('remove')"
      />
    </div>
    <transition-group name="smart-row" tag="div" class="smart-group__rows">
      <template v-for="(child, index) in group.children" :key="child.key">
        <smart-rule-row
          v-if="child.type === 'rule'"
          :rule="child"
          :suggestions="suggestionsFor(child.field)"
          :playlists="playlists"
          :readonly="readonly"
          :invalid="invalidKeys.includes(child.key)"
          @update="replace(index, $event)"
          @remove="remove(index)"
        />
        <smart-opaque-row v-else :raw="child.raw" :readonly="readonly" @remove="remove(index)" />
      </template>
    </transition-group>
    <v-btn
      v-if="!readonly"
      prepend-icon="mdi-plus"
      variant="text"
      size="small"
      class="smart-group__add"
      @click="add"
    >
      {{ $t('smartPlaylists.addCondition') }}
    </v-btn>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import {
  newRule,
  type GroupNode,
  type OpaqueNode,
  type RuleNode,
} from '@/services/navidrome/smartRules'
import type { Suggestion } from '@/services/navidrome/suggestions'
import type { Playlist } from '@/types/library'
import SmartConjunctionToggle from './SmartConjunctionToggle.vue'
import SmartOpaqueRow from './SmartOpaqueRow.vue'
import SmartRuleRow from './SmartRuleRow.vue'

/**
 * A group under the top-level rule: its own all/any, an inset panel with
 * an amber line down its edge so it reads as a unit rather than as an
 * indentation level. The editor offers one level of these and no deeper.
 */
export default {
  name: 'SmartRuleGroup',
  components: { SmartConjunctionToggle, SmartOpaqueRow, SmartRuleRow },
  props: {
    group: { type: Object as PropType<GroupNode>, required: true },
    suggestionsFor: {
      type: Function as PropType<(field: string) => Suggestion[]>,
      required: true,
    },
    playlists: { type: Array as PropType<Playlist[]>, default: () => [] },
    readonly: { type: Boolean, default: false },
    /** Rules in here not filled in enough to save. */
    invalidKeys: { type: Array as PropType<number[]>, default: () => [] },
    /** The group itself is the problem: it is empty. */
    invalid: { type: Boolean, default: false },
  },
  emits: {
    update: (group: GroupNode) => group.type === 'group',
    remove: () => true,
  },
  methods: {
    withChildren(children: (RuleNode | OpaqueNode)[]): GroupNode {
      return { ...this.group, children }
    },
    replace(index: number, rule: RuleNode): void {
      const children = [...this.group.children]
      children[index] = rule
      this.$emit('update', this.withChildren(children))
    },
    remove(index: number): void {
      this.$emit('update', this.withChildren(this.group.children.filter((_, at) => at !== index)))
    },
    add(): void {
      this.$emit('update', this.withChildren([...this.group.children, newRule()]))
    },
  },
}
</script>

<style scoped>
.smart-group {
  padding: 8px 8px 6px 14px;
  border-radius: 12px;
  border-left: 2px solid rgba(var(--v-theme-primary), 0.7);
  background: rgba(var(--v-theme-on-surface), 0.025);
}

.smart-group--invalid {
  border-left-color: rgb(var(--v-theme-error));
}

.smart-group__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 2px 0 6px;
}

.smart-group__words {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.smart-group__remove {
  margin-left: auto;
  opacity: 0.55;
}

.smart-group__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Same entrance and exit as the top-level rows (see the editor view). */
.smart-row-enter-active {
  transition:
    opacity 0.3s,
    transform 0.3s;
}

.smart-row-leave-active {
  transition: opacity 0.2s;
}

.smart-row-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.smart-row-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .smart-row-enter-active,
  .smart-row-leave-active {
    transition: none;
  }
}

.smart-group__add {
  margin-top: 4px;
  text-transform: none;
  letter-spacing: normal;
}
</style>
