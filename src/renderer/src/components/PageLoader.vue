<template>
  <div class="page-loader">
    <div class="page-loader__beacon">
      <span class="page-loader__ring" />
      <span class="page-loader__ring page-loader__ring--delay" />
      <span class="page-loader__core" />
    </div>
    <p class="page-loader__label">{{ label || $t('common.loading') }}</p>
  </div>
</template>

<script lang="ts">
/**
 * Shared "page is loading" moment — a pulsing amber beacon (rings expanding
 * outward from a warm core, like a lighthouse sweeping the dark) instead of
 * a bare spinner or a skeleton with no real shape to show yet. Used for
 * whole-page loads where nothing meaningful exists on screen until the
 * fetch resolves (album/artist/playlist/genre detail) — not for populating
 * structure that's already visible (that's what TrackList's own
 * :loading skeleton, AlbumShelf's skeleton, etc. are for).
 */
export default {
  name: 'PageLoader',
  props: {
    label: { type: String, default: '' },
  },
}
</script>

<style scoped>
.page-loader {
  display: flex;
  min-height: 50vh;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 48px 0;
}

.page-loader__beacon {
  position: relative;
  display: flex;
  width: 64px;
  height: 64px;
  align-items: center;
  justify-content: center;
}

.page-loader__core {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 16px 4px rgba(245, 169, 78, 0.7);
  animation: page-loader-core 1.8s ease-in-out infinite;
}

.page-loader__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(245, 169, 78, 0.55);
  animation: page-loader-ring 1.8s ease-out infinite;
}

.page-loader__ring--delay {
  animation-delay: 0.9s;
}

@keyframes page-loader-ring {
  0% {
    transform: scale(0.3);
    opacity: 0.9;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}

@keyframes page-loader-core {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.85;
  }
  50% {
    transform: scale(1.15);
    opacity: 1;
  }
}

.page-loader__label {
  margin: 0;
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

@media (prefers-reduced-motion: reduce) {
  .page-loader__ring,
  .page-loader__core {
    animation: none;
  }

  .page-loader__ring {
    transform: scale(0.7);
    opacity: 0.4;
  }
}
</style>
