import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { log } from "../../../shared/logger"
import type { RoutingDecision } from "../types"
import type { SessionTokenSnapshot } from "./session-token-tracker"

/**
 * Per-session state persistence to disk.
 *
 * Why: Thread state, token tracker, and decision cache are all in-memory
 * in the plugin process. When OpenCode restarts (close + reopen, new TUI
 * launch, or `opencode -c`), that state is lost and the router has to
 * re-analyze from scratch — ignoring the fact that the previous session
 * already decided on a specific model and accumulated context.
 *
 * Strategy: on every update, serialize minimal state to
 *   ~/.local/share/meridian/sessions/<sessionID>.json
 *
 * On first touch of a sessionID, we try to hydrate from disk. If the
 * file doesn't exist, we start fresh.
 *
 * Scope: only state that's useful across restarts goes here:
 *   - last routing decision (tier, model, reasons, analysis)
 *   - cumulative token snapshot
 *   - decision cache entries (scoped to session, not global)
 *
 * NOT persisted: analyzer cache (global LRU, different sessions share it)
 */

const STORE_DIR = join(homedir(), ".local/share/meridian/sessions")
const STALE_SESSION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface PersistedSessionState {
  sessionID: string
  savedAt: number
  turnCount: number
  lastDecision: RoutingDecision | null
  tokens: SessionTokenSnapshot | null
  lastCwd: string | null
  // Recent user message fingerprints for topic-shift detection
  recentUserMessages: Array<{
    ts: number
    firstChars: string // first 200 chars of the message
    tier: string
  }>
}

// In-memory cache layer so we don't hit disk on every read
const cache = new Map<string, PersistedSessionState>()

function statePath(sessionID: string): string {
  return join(STORE_DIR, `${sessionID}.json`)
}

/**
 * Load session state from disk. Returns null if no persisted state exists.
 * Results are cached in memory for subsequent reads.
 */
export async function loadSessionState(sessionID: string): Promise<PersistedSessionState | null> {
  const cached = cache.get(sessionID)
  if (cached) return cached

  try {
    const content = await readFile(statePath(sessionID), "utf-8")
    const parsed = JSON.parse(content) as PersistedSessionState
    cache.set(sessionID, parsed)
    return parsed
  } catch {
    return null
  }
}

/**
 * Save session state to disk. Best-effort — errors are logged but don't
 * throw (router must never fail because of observability I/O).
 */
export async function saveSessionState(state: PersistedSessionState): Promise<void> {
  cache.set(state.sessionID, state)
  try {
    await mkdir(dirname(statePath(state.sessionID)), { recursive: true })
    await writeFile(statePath(state.sessionID), JSON.stringify(state), { encoding: "utf-8" })
  } catch (e) {
    log("[model-router] failed to save session state", { error: String(e), sessionID: state.sessionID })
  }
}

/**
 * Update + persist the session state in one call. Uses a shallow merge.
 * Creates a new record if none exists.
 */
export async function updateSessionState(
  sessionID: string,
  patch: Partial<Omit<PersistedSessionState, "sessionID" | "savedAt">>,
): Promise<PersistedSessionState> {
  const existing = (await loadSessionState(sessionID)) ?? {
    sessionID,
    savedAt: Date.now(),
    turnCount: 0,
    lastDecision: null,
    tokens: null,
    lastCwd: null,
    recentUserMessages: [],
  }

  const merged: PersistedSessionState = {
    ...existing,
    ...patch,
    sessionID,
    savedAt: Date.now(),
  }
  await saveSessionState(merged)
  return merged
}

/**
 * Record a user message for topic-shift detection. Keeps last 10 messages.
 */
export async function recordUserMessage(
  sessionID: string,
  text: string,
  tier: string,
): Promise<void> {
  const state = (await loadSessionState(sessionID)) ?? {
    sessionID,
    savedAt: Date.now(),
    turnCount: 0,
    lastDecision: null,
    tokens: null,
    lastCwd: null,
    recentUserMessages: [],
  }

  const recent = [
    ...state.recentUserMessages,
    {
      ts: Date.now(),
      firstChars: text.slice(0, 200),
      tier,
    },
  ].slice(-10) // keep last 10

  await updateSessionState(sessionID, { recentUserMessages: recent })
}

/**
 * Clear session state — called on session.deleted / session.compacted events.
 */
export function clearSessionState(sessionID: string): void {
  cache.delete(sessionID)
  // Disk file remains — cleanup runs separately (see cleanupStaleStates)
}

/**
 * Background cleanup of old session state files. Runs once on hook
 * initialization. Removes files older than STALE_SESSION_MS.
 */
export async function cleanupStaleStates(): Promise<void> {
  try {
    const { readdir, stat, unlink } = await import("node:fs/promises")
    const entries = await readdir(STORE_DIR).catch(() => [])
    const now = Date.now()
    let removed = 0
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const filePath = join(STORE_DIR, entry)
      try {
        const s = await stat(filePath)
        if (now - s.mtimeMs > STALE_SESSION_MS) {
          await unlink(filePath)
          removed++
        }
      } catch {
        /* ignore */
      }
    }
    if (removed > 0) {
      log("[model-router] cleaned up stale session state files", { removed })
    }
  } catch {
    /* non-fatal */
  }
}
