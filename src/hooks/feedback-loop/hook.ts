import { log } from "../../shared/logger"
import { appendOutcome } from "../model-router/storage/decision-log"
import { ROUTING_LOG_PATH } from "../model-router/constants"
import { getThreadState } from "../model-router/storage/thread-state"
import type { RoutingDecision } from "../model-router/types"
import { buildOutcome, emptySignals, type SessionFeedback } from "./types"
import { classifyFollowUp } from "./follow-up-classifier"

/**
 * Feedback loop hook. Observes session events and captures 5 signals
 * that indicate whether the routing decision was good:
 *
 *   1. Follow-up message (implicit: previous answer was incomplete)
 *   2. Session error (model failed)
 *   3. Clean session.idle (task completed)
 *   4. Model fallback applied (initial choice was bad)
 *   5. User pinned different model (user corrected the router)
 *
 * Scored outcomes are appended to the routing-decisions.jsonl log as
 * separate records, joined by {sessionID, decisionTs}.
 *
 * Design principles:
 *   - Read-only: never mutates output
 *   - Idempotent: session.idle dedup window 500ms
 *   - Never blocks: disk I/O is fire-and-forget
 *   - Cleanup on session.deleted and session.compacted
 */

const DEDUP_WINDOW_MS = 500
const FLUSH_DEBOUNCE_MS = 2_000 // wait this long after last signal before flushing

interface FeedbackLoopOptions {
  enabled: boolean
  logPath: string
}

export interface FeedbackLoopHookHandle {
  "chat.message": (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>
  event: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
}

export function createFeedbackLoopHook(opts: Partial<FeedbackLoopOptions> = {}): FeedbackLoopHookHandle {
  const config: FeedbackLoopOptions = {
    enabled: opts.enabled ?? true,
    logPath: opts.logPath ?? ROUTING_LOG_PATH,
  }

  const sessions = new Map<string, SessionFeedback>()
  const flushTimers = new Map<string, NodeJS.Timeout>()

  function getOrCreate(sessionID: string): SessionFeedback {
    let state = sessions.get(sessionID)
    if (!state) {
      state = {
        sessionID,
        lastDecision: null,
        signals: emptySignals(),
        lastIdleAt: 0,
        lastOutcomeFlushedAt: 0,
      }
      sessions.set(sessionID, state)
    }
    return state
  }

  function clearSession(sessionID: string) {
    const t = flushTimers.get(sessionID)
    if (t) {
      clearTimeout(t)
      flushTimers.delete(sessionID)
    }
    sessions.delete(sessionID)
  }

  async function flushSession(sessionID: string) {
    const state = sessions.get(sessionID)
    if (!state) return
    if (!state.lastDecision) return

    // Debounce: don't double-flush within a short window
    const now = Date.now()
    if (now - state.lastOutcomeFlushedAt < DEDUP_WINDOW_MS) return

    // Mark complete if no error and no follow-up yet
    state.signals.completedCleanly =
      !state.signals.hasError && !state.signals.userFollowedUp && !state.signals.modelFallbackApplied

    const outcome = buildOutcome(state.signals)

    try {
      await appendOutcome(config.logPath, sessionID, state.lastDecision.timestamp, outcome)
      state.lastOutcomeFlushedAt = now
    } catch (e) {
      log("[feedback-loop] failed to append outcome", { error: String(e) })
    }

    // Reset signals for the next turn — keep lastDecision so we can still
    // write follow-up deltas if user continues
    state.signals = emptySignals()
  }

  function scheduleFlush(sessionID: string) {
    const existing = flushTimers.get(sessionID)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      flushTimers.delete(sessionID)
      void flushSession(sessionID)
    }, FLUSH_DEBOUNCE_MS)
    flushTimers.set(sessionID, timer)
  }

  const chatMessageHandler: FeedbackLoopHookHandle["chat.message"] = async (input, output) => {
    if (!config.enabled) return
    if (!input.sessionID) return

    const state = getOrCreate(input.sessionID)

    // Read the router's decision from thread-state (populated by the
    // model-router hook which runs BEFORE us in chat-message.ts).
    const threadState = getThreadState(input.sessionID)
    const decision = threadState?.lastDecision

    if (decision) {
      // If there was a previous decision pending flush, flush it now
      // (new user message = previous task is done)
      if (state.lastDecision) {
        // Look at the user's new message — is this a follow-up to the prior?
        const promptText = (output.parts ?? [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join(" ")
          .trim()
        if (promptText) {
          state.signals.userFollowedUp = true
          state.signals.followUpCategory = classifyFollowUp(promptText)
        }
        await flushSession(input.sessionID)
      }

      state.lastDecision = decision
    }
  }

  const eventHandler: FeedbackLoopHookHandle["event"] = async (input) => {
    if (!config.enabled) return
    const ev = input.event
    if (!ev) return
    const props = (ev.properties ?? {}) as Record<string, unknown>

    // Cleanup on session end / compaction
    if (ev.type === "session.deleted" || ev.type === "session.compacted") {
      const info = props.info as { id?: string } | undefined
      const sessionID = info?.id ?? (props.sessionID as string | undefined)
      if (sessionID) {
        // Flush any pending outcome before clearing
        await flushSession(sessionID)
        clearSession(sessionID)
      }
      return
    }

    // Session error → mark signal
    if (ev.type === "session.error") {
      const info = props.info as { sessionID?: string } | undefined
      const sessionID = info?.sessionID ?? (props.sessionID as string | undefined)
      if (!sessionID) return
      const state = sessions.get(sessionID)
      if (!state) return
      state.signals.hasError = true
      const err = props.error as { message?: string } | undefined
      state.signals.errorMessage = err?.message ?? "unknown"
      scheduleFlush(sessionID)
      return
    }

    // Tool executed → count
    if (ev.type === "tool.execute.after") {
      const info = props.info as { sessionID?: string } | undefined
      const sessionID = info?.sessionID ?? (props.sessionID as string | undefined)
      if (!sessionID) return
      const state = sessions.get(sessionID)
      if (!state) return
      state.signals.toolsExecutedCount += 1
      return
    }

    // Session idle (synthetic or real) → debounced flush
    if (ev.type === "session.idle") {
      const info = props.info as { id?: string; sessionID?: string } | undefined
      const sessionID = info?.sessionID ?? info?.id ?? (props.sessionID as string | undefined)
      if (!sessionID) return

      // Dedup window
      const state = sessions.get(sessionID)
      if (!state) return
      const now = Date.now()
      if (now - state.lastIdleAt < DEDUP_WINDOW_MS) return
      state.lastIdleAt = now

      scheduleFlush(sessionID)
      return
    }
  }

  return {
    "chat.message": chatMessageHandler,
    event: eventHandler,
  }
}
