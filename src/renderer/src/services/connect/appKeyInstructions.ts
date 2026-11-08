import type { DeviceKeyScope } from './serverLink'

const GUIDE_URL =
  'https://raw.githubusercontent.com/mihaitom/beacon/main/docs/help/faq/apps-and-api.md'

const READABLE: Partial<Record<DeviceKeyScope, string>> = {
  history: 'the listening history',
  stats: 'the statistics',
  now_playing: 'what is playing now',
  lyrics: 'the lyrics of the current song',
}

const RULES: Partial<Record<DeviceKeyScope, string[]>> = {
  history: [
    'History comes in the order plays arrived, not the order they were played. Keep `next_cursor` and ask with it later; sort by `ts` to show plays by date.',
    'A 410 on /history means the cursor expired: forget what you stored and start without one.',
  ],
  stats: [
    "/stats has no current streak: work it out from `timestamps` in the listener's time zone.",
  ],
  now_playing: [
    '`position` was correct at `at`: carry it forward while not paused instead of polling.',
    "To follow along use /now-playing/events. A browser's EventSource cannot send the key header, so read it with fetch.",
    'The cover address stays the same from song to song: fetch it again when the song changes.',
  ],
  lyrics: ['A lyric line is reached at `position - offset >= time`.'],
}

/** Text to paste into an AI assistant. Takes no key on purpose: what is pasted
 * into a chat leaves the house, so it cannot end up in there by accident. */
export function appKeyInstructions(origin: string, scopes: DeviceKeyScope[]): string {
  const readable = scopes.flatMap((scope) => READABLE[scope] ?? [])
  const rules = scopes.flatMap((scope) => RULES[scope] ?? [])
  return [
    'Help me write an app against the read-only API of my Beacon music server.',
    '',
    `Server: ${origin}`,
    `API description (OpenAPI, no key needed): ${origin}/device-link/v1/openapi.json`,
    `Guide with examples: ${GUIDE_URL}`,
    '',
    `My key may read: ${readable.join(', ')}. Anything else answers 403.`,
    'Send it as the `X-Beacon-Device-Key` header. I will give it to you separately: read it from configuration, never write it into the code.',
    '',
    'Rules:',
    '- Ignore fields you do not know, new ones may appear.',
    '- A 429 says how long to wait in `Retry-After`. Limits per key: 120 requests a minute, 3 open streams.',
    ...rules.map((rule) => `- ${rule}`),
  ].join('\n')
}
