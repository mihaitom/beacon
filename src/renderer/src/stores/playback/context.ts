/** What `this` is inside the playback store's actions.
 *
 * Written out by hand: deriving it from the store itself
 * (ReturnType<typeof usePlaybackStore>) is circular once the actions live
 * in their own files, and TypeScript then quietly widens the whole store
 * to unknown instead of reporting it. stores/playback.ts checks that the
 * store Pinia builds still matches this. */
import type { _StoreWithState } from 'pinia'
import type { MixTransition } from '@/services/connect/types'
import type { Song } from '@/types/library'
import {
  buildCastMixPayload,
  buildCastQualityPayload,
  buildCastQueuePayload,
} from '@/services/playback/castPayload'
import type { PlaybackState, QueueMoveTarget } from './state'
import type { LifecycleActions } from './lifecycle'
import type { CastActions } from './cast'
import type { TransportActions } from './transport'
import type { RadioActions } from './radio'
import type { LocalActions } from './local'
import type { PreviewActions } from './preview'
import type { QueueActions } from './queue'
import type { SettingsActions } from './settings'

export interface PlaybackGetters {
  readonly positionClamp: number
  readonly currentSong: Song | null
  readonly currentSongInLibrary: boolean
  readonly queuedSong: Song | null
  readonly lockedNextIndex: number
  readonly canSortByBpm: boolean
  readonly queueMoveTarget: (from: number, where: QueueMoveTarget) => number | null
  readonly upcomingTransition: MixTransition | null
  readonly incomingTransition: MixTransition | null
  readonly hasNext: boolean
  readonly hasPrevious: boolean
  readonly isCasting: boolean
  readonly replayGainMultiplier: number
  readonly castQualityPayload: ReturnType<typeof buildCastQualityPayload>
  readonly castQueuePayload: ReturnType<typeof buildCastQueuePayload>
  readonly castMixPayload: ReturnType<typeof buildCastMixPayload>
}

export type PlaybackActions = LifecycleActions &
  CastActions &
  TransportActions &
  RadioActions &
  LocalActions &
  PreviewActions &
  QueueActions &
  SettingsActions

export interface PlaybackContext
  extends
    PlaybackState,
    PlaybackGetters,
    LifecycleActions,
    CastActions,
    TransportActions,
    RadioActions,
    LocalActions,
    PreviewActions,
    QueueActions,
    SettingsActions,
    Pick<
      _StoreWithState<'playback', PlaybackState, PlaybackGetters, PlaybackActions>,
      '$subscribe' | '$reset'
    > {}
