/** Casting: handing over to the speakers, and following what connect reports. */
import {
  levelForJoiningSpeaker,
  resetGroupAnchor,
  sendDeviceVolume,
} from '@/services/volumeControl'
import { getAudioEngine } from '@/services/audioEngine'
import { useConnectStore } from '../connect'
import { useAutoplayStore } from '../autoplay'
import { useRadioSettingsStore } from '../radioSettings'
import { useEqualizerStore } from '../equalizer'
import { useRadioMetadataStore } from '../radioMetadata'
import * as connectPlayback from '@/services/connect/playback'
import type { ConnectDeviceRef, ConnectStatus } from '@/services/connect/types'
import { emitter } from '@/emitter'
import { i18n } from '@/i18n'
import { createKeyedGuard } from '@/services/playback/keyedGuard'
import { diffCastQueue } from '@/services/playback/queueReconcile'
import { resolveRadioStation } from '@/services/playback/radioStation'
import { getLocalMix } from '@/services/playback/localMix'
import {
  localSongChangeGuard,
  localRadioChangeGuard,
  resolveSongs,
  positionTracker,
} from './shared'
import type { PlaybackContext } from './context'

// Guards adoptCastQueue()'s per-song getSong() lookups against firing again
// for every ~2s SSE tick while resolving the same incoming queue is still in
// flight — keyed by the joined id sequence being resolved, not a single song
// id, since adopting now means mirroring the whole queue, not just the
// current song.
const queueReconcileGuard = createKeyedGuard<string>()

export interface CastActions {
  yieldToCastPlayback(): void
  reconcileFromStatus(status: ConnectStatus): Promise<void>
  adoptCastQueue(status: ConnectStatus): Promise<void>
  syncCastQueue(options?: { autoplayTopUp?: boolean }): void
  notifyCastInterrupted(): void
  resumeAfterInterruption(): Promise<void>
  castTo(targets: ConnectDeviceRef[], force?: boolean): Promise<void>
  applyTargets(desired: ConnectDeviceRef[], force?: boolean): Promise<void>
}

export const castActions: CastActions & ThisType<PlaybackContext> = {
  /** Steps this device back when a cast becomes active — the mirror image
   * of prepareLocalPlayback().
   *
   * Only the client that dispatched it silences itself on the way (see
   * castTo()). Every *other* client in the session hears of it from a
   * status tick alone, and its `<audio>` element used to play on
   * underneath the cast with nothing able to reach it: every engine
   * callback in wireAudioEngine() goes quiet once isCasting turns true, and pause()
   * addresses the cast from then on.
   *
   * stop() rather than pause(), so the src and the reconnect ladder
   * really go. The ladder matters beyond the silence for a relayed
   * station: a session has one relay (core/session.py's
   * start_radio_relay), and an element still retrying
   * /stream/radio-local would restart it on *its* station and cut the
   * cast device off.
   *
   * Nothing more is needed to join — the same tick carries the play state
   * and position, and reconcileFromStatus() the queue and station. */
  yieldToCastPlayback(): void {
    this.preview = null
    getAudioEngine().stop()
    getLocalMix().stop()
    // Both belonged to the element that just let go, and nothing refills
    // either while casting: reconnectRadio() (which is what
    // radioConnectionLost offers a button for) refuses to run then, and
    // wireAudioEngine()'s onBufferedChange has already gone quiet.
    this.bufferedPosition = 0
    this.radioConnectionLost = false
  },

  /** Keeps this.queue/currentIndex mirroring the connect backend's
   * reported queue/current_song_index whenever they're out of sync with
   * local state — connect auto-advancing on its own (see AppState.queue's
   * comment) is one cause, another *client* sharing this session editing
   * the queue (reorder/add/remove/skip — see syncCastQueue()) is another.
   * Delegates to adoptCastQueue() for the actual rebuild; this just
   * filters out the cases that don't apply (radio has no queue, our own
   * dispatch hasn't been confirmed yet). A no-op once local state already
   * matches. */
  async reconcileFromStatus(status: ConnectStatus): Promise<void> {
    if (status.radio) {
      // Our own station switch hasn't been confirmed yet - see
      // localRadioChangeGuard, and localSongChangeGuard's identical use
      // for the queue further down.
      if (localRadioChangeGuard.hasAny()) return
      // And the other direction of the same race: this client has just
      // told the backend to play a *song*, which ends the station, but
      // the tick in hand was built before that reached it. Adopting the
      // station it still reports would put the player bar back on a
      // station that is already over — with the song playing underneath
      // it. Reported live 2026-09-06.
      if (localSongChangeGuard.hasAny()) return
      if (this.radioStation?.streamUrl !== status.radio.url) {
        // Queue left alone, same as playRadioStation()'s own branch and
        // for the same reason (see its comment) — this is that same
        // switch reached from another client in the shared session
        // rather than from this one.
        this.radioStation = await resolveRadioStation(
          status.radio.url,
          status.radio.title,
          this.radioStation,
        )
        useRadioMetadataStore().reset()
        this.radioConnectionLost = false
        // Same reset playRadioStation() does, and for the identical
        // reason (see its own comment): another client switching this
        // shared session to radio takes this branch instead of that one,
        // and without it this client's stale track duration keeps
        // clamping positionTracker.extrapolate()'s live elapsed between
        // SSE ticks — the same stuck-duration bug, just reached from the
        // remote-initiated path.
        this.duration = 0
        positionTracker.reset()
        // Same reason as playRadioStation()'s own call — the station is
        // new to this client either way, and the log it has none of yet
        // should not wait out a poll interval.
        useRadioMetadataStore().startCatchup()
      }
      return
    }

    if (!status.current_song) return
    if (localSongChangeGuard.hasAny()) return // our own song switch hasn't been confirmed yet — see above
    // The same race the radio branch above guards, arrived at from the
    // other side: this client has just told the backend to play a
    // *station*, and the tick in hand still reports the song that station
    // replaced. Without this, leaveRadio() below drops the station the
    // listener already sees, the player bar falls back to the old track,
    // and only the first confirmed tick puts the station back — the
    // several seconds a /play-url dispatch takes later.
    if (localRadioChangeGuard.hasAny()) return

    // The session is playing a song, so whatever station this client
    // still shows is over — including one adopted from a stale tick a
    // moment ago (see the radio branch above). Here rather than inside
    // adoptCastQueue(), which returns early whenever the queue already
    // matches: it does match, every time, for the client that dispatched
    // the song itself, so a station recovered like that was never
    // cleared again and simply stayed on the player bar.
    this.leaveRadio()

    await this.adoptCastPreview(status)
    await this.adoptCastQueue(status)
  },

  /** Rebuilds this.queue/originalQueue/currentIndex and adopts shuffle/
   * repeatMode from connect's authoritative state (status.queue/
   * original_queue/current_song_index/shuffle/repeat_mode — see
   * AppState's comments) — the counterpart to syncCastQueue() pushing
   * local edits *out*. Together these keep every client sharing a cast
   * session showing the same queue/now-playing/toggle-state, not just
   * whichever one made the last dispatch. Without this, a
   * reorder/add/remove/skip/shuffle-toggle on *another* client stayed
   * invisible here until this client happened to already have the
   * resulting current_song somewhere in its own, unrelated queue. */
  async adoptCastQueue(status: ConnectStatus): Promise<void> {
    const remoteQueueIds = status.queue
    if (remoteQueueIds.length === 0) return // nothing dispatched on the backend side yet

    // Plain flags, no resolution needed — adopt independently of (and
    // before) the possibly-async queue rebuild below, so a flag-only
    // change from another client (e.g. toggling repeat mode without
    // touching the queue) doesn't wait on anything.
    if (this.shuffle !== status.shuffle) this.shuffle = status.shuffle
    if (this.repeatMode !== status.repeat_mode) this.repeatMode = status.repeat_mode
    this.mixNextLocked = status.next_locked
    this.mixTransitions = status.transitions ?? []
    // Same treatment, and for a sharper reason: the backend tops the
    // queue up on its own from this flag (see routes/stream.py's
    // _maybe_autoplay_topup), so a client left showing its own stored
    // value reads "off" while songs keep appearing — reported live
    // 2026-08-28 from a phone that had never sent a /play of its own and
    // so had never corrected the session's value either.
    const autoplay = useAutoplayStore()
    if (autoplay.enabled !== status.autoplay_enabled) {
      autoplay.setEnabled(status.autoplay_enabled)
    }

    const remoteOriginalIds = status.original_queue
    // See diffCastQueue()'s own comment for why an empty remote
    // original_queue counts as a match rather than something to adopt.
    const { queueMatches, originalMatches } = diffCastQueue(
      { queue: this.queue.map((t) => t.id), originalQueue: this.originalQueue.map((t) => t.id) },
      { queue: remoteQueueIds, originalQueue: remoteOriginalIds },
    )

    if (queueMatches && originalMatches) {
      // Contents already match — currentIndex can still be stale on its
      // own (e.g. a fresh SSE subscription discovering playback already
      // in progress), so that's not folded into the comparison above.
      this.currentIndex = status.current_song_index
      void this.maybeAutoplay()
      return
    }

    const key = `${remoteQueueIds.join(',')}|${remoteOriginalIds.join(',')}`
    if (queueReconcileGuard.isCurrent(key)) return // already resolving this exact pair

    queueReconcileGuard.begin(key)
    try {
      // Reuses this client's own existing Song object for any id it
      // already has (from either list) — QueueDrawer.vue/
      // MobileQueueView.vue key their rows off the object, not just the
      // id (see dedupeForQueue()'s comment), so handing them a brand-new
      // object for a song that didn't actually move would needlessly
      // break row identity/animations.
      const neededIds = [...new Set([...remoteQueueIds, ...remoteOriginalIds])]
      const resolved = await resolveSongs(neededIds, [...this.queue, ...this.originalQueue])
      // Re-check after the awaits — a local action (or a newer status
      // tick resolving first) may have already moved state on.
      if (!queueReconcileGuard.isCurrent(key)) return
      // A lookup failed for something either list needs — leave local
      // state as-is rather than adopting a queue with a hole in it; the
      // next status tick tries again.
      if (!resolved) return
      const resolvedById = new Map(resolved.map((song) => [song.id, song]))
      // The station is left to reconcileFromStatus(), which does it for
      // every tick that reports a song rather than only for the ones
      // that get this far.
      if (!queueMatches) this.queue = remoteQueueIds.map((id) => resolvedById.get(id)!)
      if (!originalMatches)
        this.originalQueue = remoteOriginalIds.map((id) => resolvedById.get(id)!)
      this.currentIndex = status.current_song_index
      void this.maybeAutoplay()
    } finally {
      queueReconcileGuard.end(key)
    }
  },

  /** Pushes the full queue to the connect backend whenever it's casting —
   * otherwise connect's own auto-advance (_advance_or_end() in
   * routes/stream.py, see AppState.queue's comment) keeps stepping through
   * whichever queue was last sent at startCurrent() time, and every
   * *other* client sharing this session keeps showing a stale queue too
   * (see build_status_dict()/adoptCastQueue()) — both invisible right up
   * until connect auto-advances on its own to the wrong song (e.g. the
   * controlling phone's screen locks before a manual skip would have
   * caught it) or someone notices the two clients disagree. A
   * `superseded` response (another client's own more recent edit already
   * won — see services/connect/playback.ts's updateQueue()) needs no
   * action here: the next real SSE status tick already carries whichever
   * queue actually won, and adoptCastQueue() picks it up from there. No-op
   * once nothing's actually playing yet (currentIndex < 0) —
   * startCurrent() sends the initial queue itself.
   *
   * `autoplayTopUp` marks a push as maybeAutoplay()'s own: only those are
   * checked by connect for two clients racing to top up (see
   * _is_duplicate_queue_topup() in routes/playback.py). A user's "Play
   * next" right after a top-up looks just like such a racer to it. */
  syncCastQueue({ autoplayTopUp = false } = {}): void {
    if (!this.isCasting) this.syncLocalMixQueue()
    if (!this.isCasting || this.currentIndex < 0) return
    // The backend is dispatching a station, not this queue — pushing the
    // queue at it would only make it look like the session had gone back
    // to songs to every other client reading the status. Whatever the
    // queue ends up as while the station plays reaches connect in one go
    // at the next startCurrent() (see castQueuePayload), which is the
    // moment it starts mattering again.
    if (this.radioStation) return
    const {
      fullQueue,
      queueIndex,
      originalQueue,
      shuffle,
      repeatMode,
      autoplayEnabled,
      autoplayBatchSize,
    } = this.castQueuePayload
    void connectPlayback
      .updateQueue(fullQueue, queueIndex, {
        song_hints: this.castMixPayload.song_hints,
        replayGainMode: this.replayGainMode,
        originalQueue,
        shuffle,
        repeatMode,
        autoplayEnabled,
        autoplayBatchSize,
        autoplayTopUp,
      })
      .catch((error) => {
        console.error('[playback] Failed to sync queue to connect:', error)
      })
  },

  /** Hands the currently loaded local song/radio off to the given cast
   * targets, or just claims them ahead of playback if nothing is loaded
   * yet — called by ConnectDevicePicker's "Connect"/"Add" action. Routed
   * through connect.withTakeoverHandling() (like claimDevices() already
   * is) so a device claimed by another session opens the takeover-confirm
   * dialog instead of the conflict just failing silently — unless `force`
   * is already true (the device-row "Take over" action decided that
   * up front), in which case there's nothing left to detect. */
  /** A cast device stopped without anyone asking it to (see
   * ConnectStatus.interrupted). Beacon cannot tell that apart from
   * somebody pressing stop on the speaker itself, so it does not resume on
   * its own - it says so and offers to, and the person decides.
   *
   * A long timeout on purpose: this asks a question rather than reporting
   * something, and the default is calibrated for glancing at a
   * notification, not for noticing one, reading it and acting on it. It
   * also stops counting down while the pointer is over it. */
  notifyCastInterrupted(): void {
    // Kept as state, not just a toast: the phone remote is fed debounced
    // *snapshots*, so a one-shot event would simply never reach it. This
    // is what both surfaces read - the desktop/mobile toast fires once
    // from here, the phone renders a banner for as long as it stands.
    this.castInterrupted = true
    const connect = useConnectStore()
    const where = connect.activeTargets.map((t) => t.name).join(', ')
    emitter.emit('toast', {
      level: 'error',
      title: i18n.global.t('connect.interruptedTitle'),
      message: where
        ? i18n.global.t('connect.interruptedOn', { device: where })
        : i18n.global.t('connect.interrupted'),
      timeoutMs: 45000,
      action: {
        label: i18n.global.t('connect.interruptedResume'),
        onClick: () => {
          void this.resumeAfterInterruption().catch(() => {
            emitter.emit('toast', [
              'error',
              i18n.global.t('connect.interruptedTitle'),
              i18n.global.t('connect.interruptedResumeFailed'),
            ])
          })
        },
      },
    })
  },

  /** Pick playback back up after castInterrupted. Shared by the toast on
   * desktop/mobile and the phone remote's banner, so the flag is cleared
   * in exactly one place however the request arrived. */
  async resumeAfterInterruption(): Promise<void> {
    await connectPlayback.resumeInterrupted()
    this.castInterrupted = false
  },

  async castTo(targets: ConnectDeviceRef[], force = false): Promise<void> {
    // Any deliberate dispatch supersedes a pending interruption - whatever
    // was interrupted is not what is about to play.
    this.castInterrupted = false
    const connect = useConnectStore()
    // Captured before either play() attempt (including a takeover retry)
    // — connect's /play always starts the device playing immediately,
    // there's no "load paused" for these cast protocols, so a handoff
    // that was paused locally needs its own explicit /pause right back
    // afterwards instead of just inheriting whatever /play did. Without
    // this, picking a cast target while paused silently resumed playback
    // the user had deliberately paused.
    const wasPlaying = this.isPlaying
    if (this.radioStation) {
      // Radio dispatches even when paused, unlike the track branch below
      // — see connectPlayback.play()'s `paused` option for why, and for
      // what that costs here: a moment of the station on the speaker
      // before the /pause lands.
      const station = this.radioStation
      const play = async (f: boolean) => {
        if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
        const response = await connectPlayback.playUrl(station.streamUrl, station.name, {
          targets,
          force: f,
          castDirectly: useRadioSettingsStore().castDirectly,
          ...this.castQualityPayload,
        })
        // Superseded by a newer dispatch — another client sharing this
        // connect session, most likely (see startCurrent()'s identical
        // check/docstring) — nothing actually changed here, so isPlaying
        // stays whatever it already was instead of guessing.
        if (response.status === 'superseded') return
        if (wasPlaying) {
          this.isPlaying = true
        } else {
          await connectPlayback.pause()
          this.isPlaying = false
        }
      }
      if (force) await play(true)
      else await connect.withTakeoverHandling(play)
    } else if (this.currentSong) {
      const song = this.currentSong
      const startPosition = this.localPosition
      const gain = this.replayGainMultiplier
      const {
        fullQueue,
        queueIndex,
        originalQueue,
        shuffle,
        repeatMode,
        autoplayEnabled,
        autoplayBatchSize,
      } = this.castQueuePayload
      const play = async (f: boolean) => {
        if (this.isPlaying) getAudioEngine().pause() // local pauses, connect takes over
        const response = await connectPlayback.play(song.id, {
          targets,
          startPosition,
          force: f,
          gain,
          replayGainMode: this.replayGainMode,
          // The same ceiling every other dispatch carries (startCurrent(),
          // and the radio branch above). Missing here, the track already
          // playing was handed to the speaker untouched however this
          // device's quality was set, and the setting only appeared to
          // work from the *next* track on - which is the one that goes
          // through startCurrent(). Reported live 2026-09-06.
          ...this.castQualityPayload,
          ...this.castMixPayload,
          equalizers: useEqualizerStore().castPayload,
          fullQueue,
          queueIndex,
          originalQueue,
          shuffle,
          repeatMode,
          autoplayEnabled,
          autoplayBatchSize,
          // Handed over as a reservation rather than as playback when
          // this device was paused: the speaker is claimed and holds the
          // track, and the next /resume is what starts it. This used to
          // be a dispatch followed by connectPlayback.pause() below,
          // which the speaker plays an audible moment of — see that
          // option's own comment.
          paused: !wasPlaying,
        })
        // See the radio branch's identical check above.
        if (response.status === 'superseded') return
        this.isPlaying = wasPlaying
      }
      if (force) await play(true)
      else await connect.withTakeoverHandling(play)
    } else {
      await connect.claimDevices(targets)
    }
  },

  /** Move the active cast targets to exactly `desired`, as one step.
   *
   * Every device picker in the app is a desired-state editor: the phone's
   * and the mobile web UI's have always been ("what's checked when I hit
   * Done"), and the desktop's now is too. This is the single place that
   * turns such a set into calls, so those three surfaces can't drift apart
   * again — they previously did, and the desktop's picker applied its
   * selection with castTo(), which *replaces* the target set. Adding a
   * second speaker to a running session therefore dropped the first one
   * instead of joining it: playback carried on there until the end of the
   * track (its stream connection was still open) and then only the newly
   * picked device kept playing.
   *
   * Additions go first and removals second, deliberately. The reverse
   * order would empty the target set in between when switching from one
   * device to another, and an empty set is not a neutral intermediate
   * state — it hands playback straight back to local speakers, which is
   * audible and is exactly what made "switch devices" unusable before.
   *
   * A join that can't go through abandons the removals with it, for the
   * same reason. Two ways that happens, and neither may be allowed to
   * fall through to the second loop: a hard failure throws out of here,
   * and a device claimed by another session comes back as `false` with
   * connect.pendingTakeover now waiting on the user's confirmation (see
   * withTakeoverHandling()). Carrying on past either one stops the
   * device that *is* playing on behalf of one that never started —
   * playback drops to local speakers mid-switch, and confirming the
   * takeover afterwards then finds no stream left to join at all
   * (routes/join.py refuses a session that isn't streaming). So the
   * takeover's retry is swapped for a full, forced re-apply: it picks up
   * whatever this pass already joined and finishes the rest, removals
   * included.
   */
  async applyTargets(desired: ConnectDeviceRef[], force = false): Promise<void> {
    // A preview plays here only; the queue's song is what gets cast.
    this.endPreview()
    const connect = useConnectStore()
    const key = (t: ConnectDeviceRef) => `${t.type}:${t.name}`
    const active = connect.activeTargets as ConnectDeviceRef[]

    if (desired.length === 0) {
      if (active.length > 0) await connect.stopAll()
      return
    }
    // Nothing running yet: this is a fresh cast, not an edit. castTo()
    // carries the queue, position and paused-state handoff that /join
    // has no reason to.
    if (active.length === 0) {
      // Several at once in 'equal' mode all start at their average.
      const startLevel = desired.length > 1 ? await levelForJoiningSpeaker(desired) : null
      resetGroupAnchor()
      await this.castTo(desired, force)
      if (startLevel != null) {
        for (const target of connect.activeTargets) {
          if (connect.isVolumeCapable(target.type)) sendDeviceVolume(target, startLevel)
        }
      }
      return
    }

    const desiredKeys = new Set(desired.map(key))
    const activeKeys = new Set(active.map(key))
    const joining = desired.filter((t) => !activeKeys.has(key(t)))
    // Read before anything joins: the level of the speakers that stay.
    const joinLevel = joining.length
      ? await levelForJoiningSpeaker(active.filter((t) => desiredKeys.has(key(t))))
      : null
    for (const target of joining) {
      const joined = await connect.joinDevice(target, force)
      if (!joined) {
        connect.setTakeoverRetry(() => this.applyTargets(desired, true))
        return
      }
      if (joinLevel != null && connect.isVolumeCapable(target.type)) {
        sendDeviceVolume(target, joinLevel)
      }
    }
    for (const target of active.filter((t) => !desiredKeys.has(key(t)))) {
      await connect.stopDevice(target.type, target.name)
    }
  },
}
