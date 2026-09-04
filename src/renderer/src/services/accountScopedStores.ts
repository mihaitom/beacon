/** Wires accountKey.ts's onAccountChange() up for every store that bakes an
 * account-scoped read into a Pinia `state()` factory (or an equivalent
 * module-level singleton cache) — those only ever run once per store
 * instance, and several of the affected stores get created at app boot, via
 * App.vue's created(), before login/restore() has resolved who's actually
 * logged in. Without this, they'd stay stuck on whichever account was (or
 * wasn't) live the moment they were first created, for the rest of the app
 * session — including, for stores/playback.ts, the very common "app
 * restarted, restore the queue I was on" case, not just multi-account
 * sharing.
 *
 * Call initAccountScopedStores() exactly once, from App.vue's created() —
 * after that, no call site anywhere else needs to think about this again.
 * Stores that already read localStorage fresh on every access (e.g.
 * services/streamQuality.ts's own load()/save(), stores/library.ts's
 * cache, stores/lyrics.ts's per-song offset corrections) don't need an
 * entry here at all — only ones with their own caching layer do.
 *
 * Also pulls this account's server-synced settings (language,
 * recommendations opt-in, lyrics providers, autoplay batch size — see
 * services/connect/accountSettings.ts and pullAccountSettings() below) on
 * the same trigger, since "the real account is now known" is exactly the
 * right moment for both jobs. Strictly *after* the local reloads, and
 * never the other way around: the local read is what this account already
 * chose on this device, the server pull is what it chose elsewhere, and
 * the server is the one allowed to win. */

import { onAccountChange } from '@/services/accountKey'
import { useUpdateStore } from '@/stores/update'
import { usePlaybackStore } from '@/stores/playback'
import { reloadLyricsCacheForAccount } from '@/stores/lyrics'
import { useRecommendationsStore } from '@/stores/recommendations'
import { useRadioSettingsStore } from '@/stores/radioSettings'
import {
  useLyricsProvidersStore,
  LYRIC_PROVIDERS,
  type LyricProvider,
} from '@/stores/lyricsProviders'
import { useAutoplayStore } from '@/stores/autoplay'
import { parseLocale } from '@/i18n'
import { adoptLocale, reloadLocaleForAccount } from '@/services/localeSetting'
import { fetchAccountSettings } from '@/services/connect/accountSettings'
import { clearCoverArtCache } from '@/services/connect/coverArtBatch'

/** Pulls whatever this account has synced server-side (see
 * services/connect/accountSettings.ts) and applies it through each
 * setting's own real setter — not a direct state patch — so the
 * sanitization every local change already gets also applies to a value
 * that came off the wire (from an older/newer build, or a hand-edited
 * account_settings.json), and so the resulting pushAccountSettings() call
 * each setter makes is just a harmless no-op merge of the same value the
 * server just sent. Server wins for whichever fields it actually has; a
 * field it's never seen (first sync ever) leaves the local value exactly
 * as it was rather than overwriting it with nothing — see the plan's own
 * "conflict policy" note for why this stays this simple (a single
 * person's own settings, not a multi-writer document). */
async function pullAccountSettings(): Promise<void> {
  try {
    const remote = await fetchAccountSettings()

    const locale = parseLocale(remote.locale ?? null)
    // Applied without pushing back: this value *is* the server's.
    if (locale) adoptLocale(locale)

    if (typeof remote.recommendationsEnabled === 'boolean') {
      useRecommendationsStore().setEnabled(remote.recommendationsEnabled)
    }

    if (Array.isArray(remote.lyricsProviders)) {
      const valid = remote.lyricsProviders.filter((p): p is LyricProvider =>
        LYRIC_PROVIDERS.includes(p as LyricProvider),
      )
      // Same distinction stores/lyricsProviders.ts's own loadEnabled()
      // makes: an empty list is a deliberate "no providers at all", but a
      // non-empty one this build recognizes *nothing* in (a newer build
      // synced providers that don't exist here yet) is not — applying it
      // would both switch every lyrics lookup off locally and push the
      // empty list straight back up, permanently destroying the selection
      // the other device made.
      if (valid.length > 0 || remote.lyricsProviders.length === 0) {
        useLyricsProvidersStore().setEnabled(valid)
      }
    }

    if (remote.autoplayBatchSize !== undefined) {
      // Sanitized inside setBatchSize() — see its comment there.
      useAutoplayStore().setBatchSize(remote.autoplayBatchSize)
    }

    if (typeof remote.castRadioDirectly === 'boolean') {
      useRadioSettingsStore().setCastDirectly(remote.castRadioDirectly)
    }
  } catch (error) {
    // Best-effort — connect being briefly unreachable shouldn't block using
    // the app with whatever's already local.
    console.error('[accountScopedStores] Failed to pull account settings:', error)
  }
}

export function initAccountScopedStores(): void {
  onAccountChange(() => {
    // Cover ids are only unique within one media server, so the artwork
    // this account is about to ask for must not be answered out of the
    // previous one's cache.
    clearCoverArtCache()
    useUpdateStore().reload()
    usePlaybackStore().reloadAccountScoped()
    reloadLyricsCacheForAccount()
    reloadLocaleForAccount()
    useRecommendationsStore().reloadForAccount()
    useLyricsProvidersStore().reloadForAccount()
    useAutoplayStore().reloadForAccount()
    useRadioSettingsStore().reloadForAccount()
    void pullAccountSettings()
  })
}
