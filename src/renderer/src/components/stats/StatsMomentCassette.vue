<template>
  <div class="stats-cassette">
    <div class="stats-cassette__shell">
      <div class="stats-cassette__light" />
      <span v-for="corner in CORNERS" :key="corner" class="stats-cassette__screw" :class="corner" />
      <div class="stats-cassette__label" />
      <div class="stats-cassette__window">
        <div class="stats-cassette__tape stats-cassette__tape--full" />
        <div class="stats-cassette__tape stats-cassette__tape--empty" />
      </div>
      <div class="stats-cassette__hub stats-cassette__hub--left" />
      <div class="stats-cassette__hub stats-cassette__hub--right" />
      <div class="stats-cassette__foot" />
    </div>
  </div>
</template>

<script lang="ts">
const CORNERS = ['is-top-left', 'is-top-right', 'is-bottom-left', 'is-bottom-right']

export default {
  name: 'StatsMomentCassette',
  data() {
    return { CORNERS }
  },
}
</script>

<style scoped>
/* A streak milestone: a run of days, side A still playing. Metal from
 * StatsMoment. */
.stats-cassette {
  position: relative;
  height: 100%;
}

.stats-cassette__shell {
  position: absolute;
  inset: 18% 0;
  overflow: hidden;
  border-radius: 7% / 11%;
  background: var(--stats-foil-metal);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.55);
}

.stats-cassette__light {
  position: absolute;
  inset: 0;
  mix-blend-mode: screen;
  background: var(--stats-foil-light);
}

.stats-cassette__screw {
  position: absolute;
  width: 2.6%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
}

.is-top-left {
  top: 5%;
  left: 3%;
}

.is-top-right {
  top: 5%;
  right: 3%;
}

.is-bottom-left {
  bottom: 5%;
  left: 3%;
}

.is-bottom-right {
  right: 3%;
  bottom: 5%;
}

.stats-cassette__label {
  position: absolute;
  inset: 9% 8% 29%;
  border-radius: 4% / 7%;
  background: linear-gradient(#232631, #10121a);
}

.stats-cassette__window {
  position: absolute;
  inset: 34% 22% 38%;
  overflow: hidden;
  border-radius: 14px;
  background: #07080c;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.08);
}

.stats-cassette__tape {
  position: absolute;
  top: 50%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: repeating-radial-gradient(circle, #2b2019 0 1px, #3a2b21 1px 2px);
  transform: translateY(-50%);
}

.stats-cassette__tape--full {
  left: 2%;
  width: 36%;
}

.stats-cassette__tape--empty {
  right: 8%;
  width: 26%;
}

.stats-cassette__hub {
  position: absolute;
  top: 36%;
  width: 12%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: repeating-conic-gradient(var(--stats-metal) 0 30deg, #07080c 30deg 60deg);
  animation: stats-cassette-play 2.9s cubic-bezier(0.12, 0.6, 0.2, 1) both;
}

.stats-cassette__hub--left {
  left: 29%;
}

.stats-cassette__hub--right {
  right: 29%;
}

@keyframes stats-cassette-play {
  from {
    transform: rotate(-900deg);
  }
}

.stats-cassette__foot {
  position: absolute;
  right: 25%;
  bottom: 0;
  left: 25%;
  height: 15%;
  background: rgba(0, 0, 0, 0.28);
  clip-path: polygon(8% 0, 92% 0, 100% 100%, 0 100%);
}

@media (prefers-reduced-motion: reduce) {
  .stats-cassette__hub {
    animation: none;
  }
}
</style>
