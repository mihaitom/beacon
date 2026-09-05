<template>
  <!-- Not a v-list-subheader: that one is Vuetify's own 14px grey label,
   - and the app already has a heading for exactly this job — a group
   - *inside* a surface. .eyebrow-label brings the type, .panel-title the
   - hairline that carries it to the far edge (see docs/styleguide.md's
   - "The two section headings"). That hairline is also why no <v-divider />
   - goes with it: the heading is the separator, so titling a section costs
   - the menu no height it did not already spend on a divider. -->
  <div class="menu-section eyebrow-label panel-title" role="presentation">{{ label }}</div>
</template>

<script lang="ts">
/**
 * The heading of one section in a right-click menu — see
 * docs/styleguide.md's context-menu section for the four sections every
 * menu in the app is cut into, and what belongs in each.
 */
export default {
  name: 'ContextMenuSection',
  props: {
    label: { type: String, required: true },
  },
}
</script>

<style scoped>
/* Lines the heading up with the menu items' own text rather than with the
 * edge of the list: 16px is v-list-item's horizontal padding at Vuetify's
 * default density, which is what these menus use. */
.menu-section {
  padding: 0 16px;
  margin-top: 10px;
  margin-bottom: 6px;
}

/* The first section starts flush with the top of the menu — the gap above
 * exists to separate it from the section before it, and there isn't one.
 * (A selection subheader can still precede it, in which case the gap is
 * wanted and this doesn't match.) */
.menu-section:first-child {
  margin-top: 6px;
}

/* .panel-title's hairline is `flex: 1 1 auto`, which in a panel means "the
 * rest of the row". A menu has no width of its own: it is as wide as its
 * widest entry, so a heading longer than every item left the hairline
 * nothing to grow into and it vanished — with a stub of a line on the
 * shorter headings beside it, which reads as a rendering fault rather than
 * a design. A minimum length makes the heading itself ask for that much
 * room when the menu measures its contents, so the line is always the
 * separator it is standing in for. */
.menu-section::after {
  min-width: 28px;
}
</style>
