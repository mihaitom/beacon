<template>
  <v-app>
    <v-main class="auth-main">
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
/* The sign-in card sits in the middle of the window, whatever its own
 * height happens to be. */
.auth-main {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
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
