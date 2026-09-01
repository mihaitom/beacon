<template>
  <!-- The image is only shown once this component has actually fetched it
   - (see loadCandidates), which is deliberate and is the whole point of the
   - component. It renders on every row of every grid and list in the app,
   - so what it does while scrolling decides what the app does to the
   - network. Three separate limits apply, and each exists because the one
   - before it wasn't enough:
   -
   -   * only covers the scroll comes to rest on are fetched at all
   -     (LOAD_SETTLE_MS),
   -   * at most MAX_CONCURRENT_LOADS are in flight across the whole app,
   -   * and a fetch is aborted the moment its cover stops being rendered.
   -
   - v-img is left as pure presentation here - it usually receives an object
   - URL for an image already in memory, so `eager` costs nothing and its own
   - intersection handling would only get in the way. The exception is an
   - image on a foreign host, which JS may render but not read (see
   - queueLoad): that one is handed to <img> as a plain URL, and only the
   - first of the three limits above applies to it. -->
  <v-avatar v-if="rounded" ref="root" :size="sizeCss" rounded="0">
    <v-img
      v-if="displaySrc"
      :src="displaySrc"
      width="100%"
      height="100%"
      cover
      eager
      @error="onImageError"
    >
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-skeleton-loader v-else-if="url" type="image" class="cover-art-skeleton" />
    <v-icon v-else :size="iconSizeCss(0.6)" :icon="fallbackIcon" />
  </v-avatar>
  <!-- v-img is sized as 100%/100% of this box, not its own copy of `size`
   - in px — a second, independent explicit size wouldn't track a CSS
   - transition put on this box's own width/height (e.g. NowPlayingView's
   - artwork-shrinks-for-lyrics animation): the box would resize smoothly
   - while the image inside it snapped instantly, since nothing here was
   - telling *it* to animate too. Filling the parent means it always
   - matches this box's current size, mid-transition or not. -->
  <div v-else ref="root" class="cover-art" :style="{ width: sizeCss, height: sizeCss }">
    <v-img
      v-if="displaySrc"
      :src="displaySrc"
      width="100%"
      height="100%"
      cover
      eager
      @error="onImageError"
    >
      <template #placeholder>
        <v-skeleton-loader type="image" class="cover-art-skeleton" />
      </template>
    </v-img>
    <v-skeleton-loader v-else-if="url" type="image" class="cover-art-skeleton" />
    <div v-else class="cover-art-fallback">
      <v-icon :size="iconSizeCss(0.5)" :icon="fallbackIcon" />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { fetchCoverArtBatched } from '@/services/connect/coverArtBatch'

// Starts the request a little before the cover actually scrolls into view,
// so it's already there (or close to it) by the time it would otherwise pop
// in, rather than only starting the fetch as it crosses the viewport edge.
const LAZY_ROOT_MARGIN = '400px 0px'

// How long a cover has to stay within that margin before it is requested at
// all. Entering the viewport is not the same as being looked at: scrolling a
// 15,000-song list from top to bottom sweeps every row through it, and
// requesting on entry alone means every one of those rows fetches its art
// for a list the user never stopped at - measured live on 2026-08-22 as
// exactly that, one request per song for a single fast scroll. A row passed
// at scrolling speed is on screen for a frame or two, far below this, so its
// timer is cancelled by the exit before it ever fires.
//
// Kept short enough to stay invisible in normal scrolling: paired with
// LAZY_ROOT_MARGIN's 400px of lead, a cover has this long *plus* the time it
// takes to travel those 400px before anyone can see whether it arrived.
const LOAD_SETTLE_MS = 150

// How many covers may be fetching at once, across the whole app.
//
// Nothing in the browser enforces this any more. Under HTTP/1.1 the
// six-connections-per-origin limit quietly did it for us; over HTTP/2 the
// browser multiplexes as many requests as it is handed, so a list settling
// with sixty covers on screen sends sixty at once - and in a deployment
// where the app and the media server sit behind the same reverse proxy,
// each of those crosses it twice and pays an authorisation round trip each
// time. On 2026-08-23 that burst took a household's playback down: the
// proxy's authorisation middleware stopped answering in time, failed closed,
// and every request through it - including the *casting streams' own media
// fetches* - was denied for as long as the burst lasted. See
// docs/playback-bugs/mid-track-drop-reverse-proxy-403.md, "The mechanism".
//
// The number itself is a compromise, and worth re-deriving rather than
// guessing at if it ever needs changing. A cover takes roughly one proxy
// round trip (~106 ms measured), so a limit of N produces about 10·N
// requests per second from the app, and the proxy sees twice that because
// every one of them crosses it a second time on the backend's behalf. The
// outage peaked at 142 requests per second - sustained for minutes, because
// nothing cancelled. Twelve puts the ceiling near that peak but only in
// bursts that now end the moment the scroll moves on, and fills a large
// grid in half the time six did.
//
// The limit is cheap insurance, not the load-bearing part: the viewport
// gate and the cancellation below are what actually keep the request count
// down, and a client that only ever fetches covers it is about to show,
// and stops fetching the moment it isn't, stays well clear of the ceiling
// on its own. This only bounds what a burst can do before those two take
// effect.
export const MAX_CONCURRENT_LOADS = 12
let inFlight = 0
const waiting: Array<() => void> = []

/** Runs `start` once a slot is free. Returns a cancel function for a cover
 * that is scrolled away or unmounted while still queued - without it, a fast
 * scroll through a long list would still fetch every cover it passed, just
 * more slowly. */
function takeLoadSlot(start: () => void): () => void {
  if (inFlight < MAX_CONCURRENT_LOADS) {
    inFlight += 1
    start()
    return () => {}
  }
  waiting.push(start)
  return () => {
    const at = waiting.indexOf(start)
    if (at >= 0) waiting.splice(at, 1)
  }
}

/** Hands the slot straight to whoever is waiting, so the queue keeps moving
 * without an extra scheduling turn. Only ever called by a slot holder. */
function releaseLoadSlot(): void {
  const next = waiting.shift()
  if (next) next()
  else inFlight -= 1
}

/** A candidate with no coverArtId to batch by — reached for any `imageUrl`
 * that queueLoad's isProxyUrl check decided IS worth fetching-and-holding
 * rather than handing to a plain <img> (a same-origin one, e.g. a radio
 * station's favicon, built by services/connect/radio.ts's radioFaviconUrl
 * and passed in by SongInfo.vue/NowPlayingView.vue/HeroBand.vue — not just
 * a defensive branch for a case this component itself never produces). */
async function fetchDirect(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, priority: 'low' } as RequestInit)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.blob()
}

export default {
  name: 'CoverArt',
  props: {
    coverArtId: {
      type: String as PropType<string | null>,
      default: null,
    },
    /** Direct image URL — tried before coverArtId when given (e.g.
     * Navidrome's artistImageUrl, a real photo rather than an album-cover
     * placeholder, already a full pre-signed URL outside our proxy). Many
     * artists have no cached photo and this 404s — falls back to
     * coverArtId, then to the icon placeholder, on load failure. */
    imageUrl: {
      type: String as PropType<string | null>,
      default: null,
    },
    // A plain number is pixels (unchanged behavior everywhere else); a
    // string is used as-is as a raw CSS size (e.g. NowPlayingView.vue's
    // own "70vh" — sizing its big artwork off the viewport instead of a
    // fixed pixel figure that reads too small on a tall window and too
    // large on a short one). See sizeCss/fetchSize/iconSizeCss below for
    // how each of this component's three actual uses of `size` (its own
    // CSS box, the resolution requested from the media server, and the
    // fallback icon's proportional size) handle either shape.
    size: {
      type: [Number, String] as PropType<number | string>,
      default: 160,
    },
    rounded: {
      type: Boolean,
      default: false,
    },
    /** Icon shown when there's no cover (and no imageUrl fallback either) —
     * albums/songs want the generic record icon, but other kinds of
     * covers (playlists, ...) read oddly with that, so it's overridable. */
    fallbackIcon: {
      type: String,
      default: 'mdi-album',
    },
  },
  data() {
    return {
      // Index into the candidate list below — advances when a fetch fails
      // until exhausted, at which point `url` returns null (icon
      // placeholder).
      failedCount: 0,
      // The fetched image, as an object URL. Null until it has arrived, so
      // the skeleton stays up for exactly as long as there is nothing to
      // show. Revoked whenever it's replaced or the component goes away —
      // an object URL keeps its blob alive until it is.
      objectUrl: null as string | null,
      // The in-flight fetch, so it can be aborted. This is why the fetching
      // isn't left to v-img: a request nobody is waiting for any more should
      // stop costing bandwidth, a connection and (in the deployment above)
      // an authorisation lookup — and it should hand its concurrency slot to
      // the next cover immediately rather than when it happens to finish.
      controller: null as AbortController | null,
      // A candidate on a foreign host, handed straight to <img> because JS
      // isn't allowed to read its bytes (see SubsonicClient.isProxyUrl).
      // Mutually exclusive with objectUrl.
      directUrl: null as string | null,
      // Whether this cover is currently within LAZY_ROOT_MARGIN of the
      // viewport, as last reported by the observer below. Kept separately
      // rather than asked for on demand, because the observer is deliberately
      // torn down the moment it has nothing left to decide (see
      // setObjectUrl/queueLoad) — this keeps its final answer, which stays
      // true for a cover that simply never leaves the screen.
      inView: false,
      observer: null as IntersectionObserver | null,
      settleTimer: null as number | null,
      holdsLoadSlot: false,
      cancelQueued: null as (() => void) | null,
    }
  },
  computed: {
    // This component's own CSS box (width/height, both branches) — a
    // number needs "px" appended, a string (already a full CSS value) is
    // used as-is.
    sizeCss(): string {
      return typeof this.size === 'number' ? `${this.size}px` : this.size
    },
    // What resolution to actually request from the media server — needs a
    // real pixel number regardless of how this ends up displayed. A
    // numeric `size` doubles as both (unchanged behavior); a CSS size
    // string (e.g. "70vh") has no pixel figure to derive this from, so
    // this falls back to a fixed resolution generous enough for that
    // caller's biggest realistic on-screen size.
    fetchSize(): number {
      return typeof this.size === 'number' ? this.size : 640
    },
    // coverArtId is only ever set on the entry built from this.coverArtId
    // (never on imageUrl's) — loadCandidates() uses it to tell which
    // network path a given candidate needs (see fetchCoverArtBatched vs
    // fetchDirect above).
    candidates(): Array<{ url: string; coverArtId: string | null }> {
      const coverArtUrl = this.coverArtId
        ? useLibraryStore().client().coverArtUrl(this.coverArtId, this.fetchSize)
        : null
      const entries: Array<{ url: string; coverArtId: string | null } | null> = [
        this.imageUrl ? { url: this.imageUrl, coverArtId: null } : null,
        coverArtUrl ? { url: coverArtUrl, coverArtId: this.coverArtId } : null,
      ]
      return entries.filter((e): e is { url: string; coverArtId: string | null } => e !== null)
    },
    url(): string | null {
      return this.candidates[this.failedCount]?.url ?? null
    },
    /** What the <img> actually shows: an image this component fetched and
     * holds in memory, or one a foreign host is loading directly. */
    displaySrc(): string | null {
      return this.objectUrl ?? this.directUrl
    },
  },
  watch: {
    // candidates() also depends on useLibraryStore().client(), which reads
    // the *current* auth store state on every call — not just imageUrl/
    // coverArtId. If this component's first render happens to race ahead of
    // auth actually being ready (e.g. connectToken/credential still empty
    // right at app boot — main.ts mounts before router.isReady() resolves,
    // see App.vue's own comment on that), the very first URL 404s,
    // failedCount advances past it, and candidates[failedCount] silently
    // points past the end forever — even once auth catches up moments
    // later and the *same* candidate index would now resolve to a working
    // URL, since nothing here previously reset the count for that case.
    // Watching the whole (always-freshly-built, see candidates() above)
    // array catches every reason its contents could have changed, not just
    // these two props specifically.
    candidates() {
      this.failedCount = 0
      // A different cover entirely — drop what's on screen and fetch the new
      // one if this instance had already earned its place (an always-visible
      // instance like the player bar's own art, on every track change).
      //
      // `inView` is what covers the boot race described above, and it is the
      // only one of the three that does: an instance whose *first* attempt
      // failed is showing nothing and holds no slot, so the other two are
      // both false exactly when a retry is most needed. Nothing else would
      // ever start one either — an IntersectionObserver only reports
      // *changes*, and a cover that has been sitting in the viewport since
      // it mounted (the player bar's own art, for the whole life of the app)
      // never produces another entry to react to.
      const shouldLoad = this.displaySrc !== null || this.holdsLoadSlot || this.inView
      this.abortLoad()
      this.setObjectUrl(null)
      this.directUrl = null
      if (shouldLoad) this.queueLoad()
    },
  },
  mounted() {
    // Either of these means there's nothing to observe against, so the
    // choice is "load now" or "never load" — and a cover that never appears
    // is by far the worse failure. No IntersectionObserver at all is jsdom
    // under test or a very old browser; no resolvable root element
    // shouldn't happen, but see rootElement() for why $el alone can't be
    // trusted here.
    const target = this.rootElement()
    if (typeof IntersectionObserver === 'undefined' || !target) {
      this.inView = true
      this.queueLoad()
      return
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries[entries.length - 1]?.isIntersecting ?? false
        this.inView = isIntersecting
        if (isIntersecting) {
          this.startSettle()
        } else {
          this.cancelSettle()
        }
      },
      { rootMargin: LAZY_ROOT_MARGIN },
    )
    this.observer.observe(target)
  },
  beforeUnmount() {
    // The component is going away — in a virtualized list (SongTable.vue's
    // v-virtual-scroll) that happens to rows by the hundred while scrolling.
    // Everything this cover still owns has to go with it: a pending timer, a
    // queued place, an in-flight request, its slot, and its object URL.
    this.cancelSettle()
    this.abortLoad()
    this.releaseSlot()
    this.setObjectUrl(null)
    this.observer?.disconnect()
    this.observer = null
  },
  methods: {
    /** The DOM element to watch. Deliberately not `this.$el`: this
     * component's two root branches have template comments between them,
     * which a dev build keeps, making the component a *fragment* — and
     * `$el` is then the first node of that fragment, i.e. a comment node,
     * which IntersectionObserver.observe() rejects outright ("parameter 1
     * is not of type 'Element'"). A ref on each branch's actual root
     * always resolves to the real element, whichever branch rendered.
     * The avatar branch's ref is a component, not an element, so its own
     * root has to be unwrapped. */
    rootElement(): Element | null {
      const root = this.$refs.root as Element | { $el?: unknown } | undefined
      if (root instanceof Element) return root
      const el = root && '$el' in root ? root.$el : null
      return el instanceof Element ? el : null
    },
    startSettle() {
      if (this.displaySrc || this.holdsLoadSlot || this.settleTimer !== null) return
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = null
        this.queueLoad()
      }, LOAD_SETTLE_MS)
    },
    /** The cover left the viewport (or is going away entirely). Everything it
     * has in progress is now work for a cover nobody is looking at, so all
     * three stages are wound back: the pending timer, a queued place, and a
     * request already on the wire. A cover that made it far enough to be
     * *shown* is left alone - it costs nothing further, and dropping it would
     * make scrolling back flash empty boxes. */
    cancelSettle() {
      if (this.settleTimer !== null) {
        window.clearTimeout(this.settleTimer)
        this.settleTimer = null
      }
      this.cancelQueued?.()
      this.cancelQueued = null
      if (!this.displaySrc) {
        this.abortLoad()
        this.releaseSlot()
      }
    },
    queueLoad() {
      const url = this.url
      if (!url) return
      // A foreign host (artist photo, radio favicon) can't be fetched from
      // JS at all — no CORS headers, so reading the bytes is forbidden even
      // though rendering them isn't. Those go straight to <img>, unqueued
      // and uncancellable: neither matters for them, since they don't touch
      // the media server or the proxy in front of it, and they appear a
      // handful at a time rather than by the screenful.
      if (!useLibraryStore().client().isProxyUrl(url)) {
        this.directUrl = url
        this.observer?.disconnect()
        this.observer = null
        return
      }
      // A previous call already has this instance queued (waiting for a
      // slot, not holding one yet) — the candidates() watcher can call this
      // again before that one ever started (a track change landing during a
      // queue backlog), and without this the old entry sits orphaned in
      // `waiting` forever: a place held for an instance that no longer
      // wants it, while a second, newer one queues right behind it.
      this.cancelQueued?.()
      this.cancelQueued = null
      // Already running (holdsLoadSlot true) — loadCandidates()'s own
      // while(this.url) loop picks up the new candidate itself once
      // abortLoad() unblocks it (see that method's AbortError branch),
      // still inside the one slot it already holds. Requesting a second
      // slot here would instead run two overlapping loadCandidates() calls
      // on the same instance, racing over the shared
      // this.controller/holdsLoadSlot fields — observed live 2026-08-24 as
      // a cover stuck on its skeleton forever despite the fetch actually
      // succeeding: whichever of the two calls finished last (the stale,
      // already-superseded one) still ran its own finally and reset
      // holdsLoadSlot out from under the other.
      if (this.holdsLoadSlot) return
      this.cancelQueued = takeLoadSlot(() => {
        this.cancelQueued = null
        this.holdsLoadSlot = true
        void this.loadCandidates()
      })
    },
    /** The <img> itself refused what it was given — a foreign photo that
     * 404s (an artist without one falls back to the album cover behind it),
     * or, far less likely, bytes we fetched that turn out not to be an
     * image. Either way: on to the next candidate. */
    onImageError() {
      this.setObjectUrl(null)
      this.directUrl = null
      this.failedCount += 1
      this.queueLoad()
    },
    /** Works down the candidate list within the one slot it was granted, so
     * a cover whose first URL 404s (a missing artist photo, see imageUrl)
     * doesn't have to queue again for its fallback. */
    async loadCandidates(): Promise<void> {
      try {
        while (this.url) {
          const candidate = this.candidates[this.failedCount]!
          const controller = new AbortController()
          this.controller = controller
          try {
            // Batched (grouped with whatever else settles in the same
            // ~20ms window — see coverArtBatch.ts) for a real coverArtId;
            // fetchDirect for anything else this component fetches and
            // holds that has no id to batch by (see its own comment). Low
            // priority isn't meaningful for the batched path (it's one POST
            // request, not an image fetch the browser could deprioritize)
            // — cover art already being the least urgent thing the app
            // asks for is what the settle delay and slot queue above are
            // for instead.
            const blob = candidate.coverArtId
              ? await fetchCoverArtBatched(candidate.coverArtId, this.fetchSize, controller.signal)
              : await fetchDirect(candidate.url, controller.signal)
            this.setObjectUrl(URL.createObjectURL(blob))
            return
          } catch (error) {
            if ((error as Error)?.name === 'AbortError') {
              // Two different reasons this loop's own fetch gets aborted,
              // told apart by holdsLoadSlot: cancelSettle()/beforeUnmount()
              // both release the slot *before* aborting when this cover
              // genuinely stopped being wanted (scrolled away, unmounting)
              // — holdsLoadSlot is already false by the time this runs, so
              // there's truly nothing left to load and this loop ends.
              // Otherwise this was the candidates() watcher: it aborts,
              // then calls queueLoad() again, which is now a deliberate
              // no-op while holdsLoadSlot is still true (see queueLoad()'s
              // own comment) — the new candidate is only ever going to be
              // picked up here, by falling through to this loop's own
              // while(this.url) re-check, still inside the one slot this
              // call already holds. Not a failure of this URL either way,
              // so failedCount is untouched.
              if (!this.holdsLoadSlot) return
            } else {
              this.failedCount += 1
            }
          } finally {
            if (this.controller === controller) this.controller = null
          }
        }
      } finally {
        this.releaseSlot()
      }
    },
    abortLoad() {
      this.controller?.abort()
      this.controller = null
    },
    /** This cover's turn is over, one way or another — pass the slot on. */
    releaseSlot() {
      if (!this.holdsLoadSlot) return
      this.holdsLoadSlot = false
      releaseLoadSlot()
    },
    setObjectUrl(next: string | null) {
      // An object URL keeps its blob in memory until it's revoked, and this
      // component exists by the thousand.
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = next
      if (next) {
        // Arrived — there is nothing left for the observer to decide. Until
        // this point it has to keep watching, because leaving the viewport
        // mid-flight is exactly what should abort the request.
        this.observer?.disconnect()
        this.observer = null
      }
    },
    // Fallback icon's proportional size (0.6 for the rounded avatar
    // variant, 0.5 for the plain box — see the template). CSS calc(),
    // not arithmetic on `size` directly, so this still works when `size`
    // is a viewport-relative string rather than a plain pixel number.
    iconSizeCss(fraction: number): string {
      return typeof this.size === 'number'
        ? `${this.size * fraction}px`
        : `calc(${this.size} * ${fraction})`
    },
  },
}
</script>

<style scoped>
.cover-art {
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
}

.cover-art-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.3);
}

/* Shown for as long as there is no image to show yet — without this, the
 * cover briefly renders empty/transparent between "data arrived" and
 * "image arrived". .v-img__placeholder is already position:absolute +
 * 100%/100%, so this just needs to fill that; the parent (.cover-art or
 * the avatar) already clips to the right shape. */
.cover-art-skeleton {
  width: 100%;
  height: 100%;
  border-radius: 0;
}

.cover-art-skeleton :deep(.v-skeleton-loader__bone) {
  margin: 0;
  width: 100%;
  height: 100%;
}
</style>
