/**
 * Session token tracker — caches cumulative token usage per session
 * from `message.updated` events. Used by the router to detect heavy
 * contexts (e.g., 700k+ tokens) where switching to a weaker model
 * would be catastrophic (compaction with wrong model, capability loss).
 *
 * Pattern borrowed from context-window-monitor hook. Same data shape
 * so future consolidation is easy.
 */

export interface SessionTokenSnapshot {
  providerID: string
  modelID: string
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  updatedAt: number
}

const tokenCache = new Map<string, SessionTokenSnapshot>()

export function recordSessionTokens(snapshot: SessionTokenSnapshot): void {
  tokenCache.set(
    snapshot.providerID + ":" + (snapshot as unknown as { sessionID?: string }).sessionID!,
    snapshot,
  )
}

export function getSessionTokens(sessionID: string): SessionTokenSnapshot | undefined {
  // Find any entry whose sessionID matches (we key by providerID:sessionID)
  for (const [key, value] of tokenCache.entries()) {
    if (key.endsWith(":" + sessionID)) return value
  }
  return undefined
}

export function setSessionTokens(
  sessionID: string,
  snapshot: Omit<SessionTokenSnapshot, "updatedAt">,
): void {
  tokenCache.set(snapshot.providerID + ":" + sessionID, {
    ...snapshot,
    updatedAt: Date.now(),
  })
}

export function clearSessionTokens(sessionID: string): void {
  for (const key of Array.from(tokenCache.keys())) {
    if (key.endsWith(":" + sessionID)) tokenCache.delete(key)
  }
}

/**
 * Compute total input tokens currently in the session's context window.
 * Includes both fresh input and cache reads (both count toward the
 * context limit from the model's perspective).
 */
export function getTotalInputTokens(sessionID: string): number {
  const snap = getSessionTokens(sessionID)
  if (!snap) return 0
  return (snap.tokens.input ?? 0) + (snap.tokens.cache?.read ?? 0)
}

/**
 * Describe the context load for router decisions:
 *   - "fresh": < 20k tokens (new session)
 *   - "normal": 20k - 100k tokens (typical work)
 *   - "heavy": 100k - 300k tokens (lots of context loaded)
 *   - "saturated": > 300k tokens (near limit, approaching compaction)
 */
export type ContextLoad = "fresh" | "normal" | "heavy" | "saturated"

function classifyLoad(totalInputTokens: number): ContextLoad {
  if (totalInputTokens < 20_000) return "fresh"
  if (totalInputTokens < 100_000) return "normal"
  if (totalInputTokens < 300_000) return "heavy"
  return "saturated"
}

export function describeContextLoad(sessionID: string): {
  load: ContextLoad
  totalInputTokens: number
  snapshot: SessionTokenSnapshot | undefined
} {
  const snap = getSessionTokens(sessionID)
  const totalInputTokens = getTotalInputTokens(sessionID)
  return { load: classifyLoad(totalInputTokens), totalInputTokens, snapshot: snap }
}

/**
 * Estimate token count from a text blob. Uses the common ~4-chars-per-token
 * heuristic — not exact but good enough for context-load classification
 * (we only care about orders of magnitude: fresh/normal/heavy/saturated).
 */
export function estimateTokens(text: string): number {
  // ~3.8 chars/token for English, ~3.2 for pt-BR (more vowels). Use 3.5.
  return Math.ceil(text.length / 3.5)
}

/**
 * Compute context load by comparing the message-update tracker cache
 * against a history-derived estimate. This fixes the case where a
 * streaming response gets cancelled (user interrupts, sends new message)
 * and `message.updated finish:true` never arrives, leaving the cached
 * token count stale at 0 and making the router think the session is
 * fresh when in fact it's already loaded with hundreds of kilobytes of
 * context.
 *
 * Policy: take the MAX of both sources. After a stream completes
 * successfully, the tracker holds precise numbers. During interruption
 * or cold start with hydrated state, the history estimate is the only
 * live signal and prevents dangerous downgrades.
 */
export function describeContextLoadWithFallback(args: {
  sessionID: string
  historyTokenEstimate: number
}): {
  load: ContextLoad
  totalInputTokens: number
  source: "tracker" | "history" | "both"
} {
  const trackerTokens = getTotalInputTokens(args.sessionID)
  const historyTokens = Math.max(0, args.historyTokenEstimate)

  let source: "tracker" | "history" | "both"
  let totalInputTokens: number

  if (trackerTokens > 0 && historyTokens > 0) {
    totalInputTokens = Math.max(trackerTokens, historyTokens)
    source = "both"
  } else if (trackerTokens > 0) {
    totalInputTokens = trackerTokens
    source = "tracker"
  } else {
    totalInputTokens = historyTokens
    source = "history"
  }

  return { load: classifyLoad(totalInputTokens), totalInputTokens, source }
}
