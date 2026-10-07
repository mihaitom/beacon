import type { NowPlayingSource } from './source'
import { nowPlayingSourceKey } from './source'

/** Injects the Now Playing source the host or guest page provided, as
 * `this.source`. Every shared presentation component mixes this in instead
 * of importing a store. */
export const nowPlayingSourceMixin = {
  inject: {
    nowPlayingSource: { from: nowPlayingSourceKey },
  },
  computed: {
    source(this: { nowPlayingSource: NowPlayingSource }): NowPlayingSource {
      return this.nowPlayingSource
    },
  },
}
