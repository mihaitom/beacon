<template>
  <div @pointerover="show" @pointerleave="hide">
    <slot />
    <!-- One tooltip moved between its targets: a year of days would otherwise
       - be 371 of them. -->
    <v-tooltip
      :model-value="target !== null"
      :activator="target ?? undefined"
      location="top"
      :open-on-hover="false"
      :transition="false"
    >
      {{ text }}
    </v-tooltip>
  </div>
</template>

<script lang="ts">
export default {
  name: 'StatsTips',
  data() {
    return { target: null as HTMLElement | null, text: '' }
  },
  methods: {
    show(event: PointerEvent): void {
      const element = (event.target as HTMLElement).closest<HTMLElement>('[data-tip]')
      this.target = element
      this.text = element?.dataset.tip ?? ''
    },
    hide(): void {
      this.target = null
    },
  },
}
</script>
