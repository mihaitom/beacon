/**
 * Deterministic session id derived from the Navidrome login, so the same
 * login always lands on the same Connect session (and reconnects reuse
 * device claims/status instead of spawning a fresh session every login).
 * FNV-1a, matching the old React client's connect-session-id.ts.
 */
export function computeConnectSessionId(params: {
  url: string
  serverType: string
  userId: string
  username: string
}): string {
  const identity = params.userId || params.username
  const input = `${params.url}::${params.serverType}::${identity}`

  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
