/**
 * Session mutex — serializes chat.message handler execution per session.
 *
 * Problem: OpenCode's chat.message hook is async. When a user sends
 * multiple messages in rapid succession (cancel stream A, send B, cancel
 * B, send C), the hook fires multiple instances in parallel for the same
 * sessionID. Each instance reads ThreadState independently, and the last
 * writer wins on persistence — causing:
 *   - turnCount drift
 *   - lastDecision overwrites losing correct tier
 *   - analyzer called 3x in parallel, each burning rate-limit budget
 *
 * Fix: per-session lock. Concurrent handlers for the SAME sessionID run
 * serially; handlers for DIFFERENT sessions run in parallel. Uses a
 * Promise chain pattern — no external deps.
 *
 * This mutex is in-memory only. Across process restarts it's irrelevant
 * (each cold start re-hydrates state from disk before running).
 */

const sessionChains = new Map<string, Promise<unknown>>()

/**
 * Serialize `fn` execution for the given sessionID. If another call is
 * already in progress for this session, wait for it to finish before
 * starting. Errors in `fn` do NOT block the queue — the chain advances
 * regardless so one failing turn doesn't deadlock the session.
 */
export async function withSessionLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionChains.get(sessionID) ?? Promise.resolve()

  // Build the next link: wait for `previous`, swallow its errors
  // (they belong to the previous caller, not us), then run `fn`.
  const next = previous
    .catch(() => {
      /* previous turn's error — not our concern */
    })
    .then(() => fn())

  // Store a safe version (errors swallowed) in the map so the next
  // caller doesn't inherit our rejection — but keep `next` itself with
  // its real error so our caller sees it via the `await` below.
  const safe: Promise<unknown> = next.catch(() => undefined)
  sessionChains.set(sessionID, safe)

  try {
    return await next
  } finally {
    // Best-effort cleanup: if we're still the newest link, clear the
    // entry. If another call chained on top of us, leave it alone.
    if (sessionChains.get(sessionID) === safe) {
      sessionChains.delete(sessionID)
    }
  }
}

/**
 * Drop the lock chain for a session. Called on session.deleted /
 * session.compacted to avoid unbounded memory growth.
 */
export function clearSessionLock(sessionID: string): void {
  sessionChains.delete(sessionID)
}

/**
 * Testing/diagnostics: how many sessions currently have a lock chain.
 */
export function activeSessionLocks(): number {
  return sessionChains.size
}
