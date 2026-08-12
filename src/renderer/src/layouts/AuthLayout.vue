<template>
  <v-app>
    <v-main class="d-flex align-center justify-center fill-height auth-main">
      <div class="auth-glow" />
      <router-view />
    </v-main>
  </v-app>
</template>

<script lang="ts">
export default {
  name: 'AuthLayout',
}
</script>

<style scoped>
.auth-main {
  position: relative;
  overflow: hidden;
}

.auth-glow {
  position: absolute;
  top: -25%;
  left: 50%;
  width: 900px;
  height: 900px;
  transform: translateX(-50%);
  background: radial-gradient(
    circle,
    rgba(245, 169, 78, 0.16) 0%,
    rgba(245, 169, 78, 0.06) 35%,
    transparent 70%
  );
  pointer-events: none;
}
</style>
