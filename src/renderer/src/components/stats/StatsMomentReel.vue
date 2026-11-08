<template>
  <div class="stats-reel">
    <div class="stats-reel__back" />
    <div class="stats-reel__tape" />
    <div class="stats-reel__turning">
      <div class="stats-reel__flange"><div class="stats-reel__light" /></div>
      <div class="stats-reel__hub" />
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'StatsMomentReel' }
</script>

<style scoped>
/* An hours milestone: time, wound onto tape. Metal from StatsMoment. */
.stats-reel {
  position: relative;
  height: 100%;
  border-radius: 50%;
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.55);
}

.stats-reel__back {
  position: absolute;
  inset: 1%;
  border-radius: 50%;
  background: #0b0c11;
}

.stats-reel__tape {
  position: absolute;
  inset: 14%;
  border-radius: 50%;
  background: repeating-radial-gradient(circle, #2b2019 0 1px, #3a2b21 1px 2px, #241a14 2px 3px);
  box-shadow: inset 0 0 18px rgba(0, 0, 0, 0.6);
  animation: stats-reel-wind-up 2.9s cubic-bezier(0.12, 0.6, 0.2, 1) both;
}

@keyframes stats-reel-wind-up {
  from {
    transform: scale(0.62);
  }
}

.stats-reel__turning {
  position: absolute;
  inset: 0;
  animation: stats-reel-turn 2.9s cubic-bezier(0.12, 0.6, 0.2, 1) both;
}

@keyframes stats-reel-turn {
  from {
    transform: rotate(-720deg);
  }
}

/* The three windows the tape shows through. */
.stats-reel__flange {
  --windows: url('data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20200%20200%27%3E%3Cmask%20id%3D%27m%27%20maskUnits%3D%27userSpaceOnUse%27%20x%3D%270%27%20y%3D%270%27%20width%3D%27200%27%20height%3D%27200%27%3E%3Crect%20width%3D%27200%27%20height%3D%27200%27%20fill%3D%27white%27%2F%3E%3Cpath%20d%3D%27M64.29%2054.30A58%2058%200%200%201%20135.71%2054.30%27%20stroke%3D%27black%27%20stroke-width%3D%2740%27%20stroke-linecap%3D%27round%27%20fill%3D%27none%27%2F%3E%3Cpath%20d%3D%27M157.44%2091.93A58%2058%200%200%201%20121.73%20153.78%27%20stroke%3D%27black%27%20stroke-width%3D%2740%27%20stroke-linecap%3D%27round%27%20fill%3D%27none%27%2F%3E%3Cpath%20d%3D%27M78.27%20153.78A58%2058%200%200%201%2042.56%2091.93%27%20stroke%3D%27black%27%20stroke-width%3D%2740%27%20stroke-linecap%3D%27round%27%20fill%3D%27none%27%2F%3E%3C%2Fmask%3E%3Ccircle%20cx%3D%27100%27%20cy%3D%27100%27%20r%3D%2799%27%20fill%3D%27white%27%20mask%3D%27url%28%23m%29%27%2F%3E%3C%2Fsvg%3E');
  position: absolute;
  inset: 0;
  background: var(--stats-foil-metal);
  mask: var(--windows) center / 100% 100%;
}

.stats-reel__flange::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-radial-gradient(circle, rgba(0, 0, 0, 0.1) 0 1px, transparent 1px 7px);
}

.stats-reel__light {
  position: absolute;
  inset: 0;
  mix-blend-mode: screen;
  background: var(--stats-foil-light);
}

.stats-reel__hub {
  position: absolute;
  inset: 39%;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #2a2e3b, #12141c);
  box-shadow:
    0 0 0 2px var(--stats-metal),
    inset 0 0 8px rgba(0, 0, 0, 0.6);
}

.stats-reel__hub::after {
  content: '';
  position: absolute;
  inset: 30%;
  border-radius: 50%;
  background: repeating-conic-gradient(var(--stats-metal) 0 26deg, transparent 26deg 120deg);
}

@media (prefers-reduced-motion: reduce) {
  .stats-reel__tape,
  .stats-reel__turning {
    animation: none;
  }
}
</style>
