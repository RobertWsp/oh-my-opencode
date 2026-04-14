import type { RoutingDecision, ThreadState } from "../types"

/**
 * In-memory per-session state for the router. Tracks the last decision
 * so multi-turn logic can decide whether to reuse it (cached) or re-analyze.
 * Also holds opus-plan state machine flag.
 */

const threadStates = new Map<string, ThreadState>()

export function getThreadState(sessionID: string): ThreadState | undefined {
  return threadStates.get(sessionID)
}

export function getOrCreateThreadState(sessionID: string): ThreadState {
  let state = threadStates.get(sessionID)
  if (!state) {
    state = {
      sessionID,
      lastDecision: null,
      lastPromptText: "",
      turnCount: 0,
      lastUpdatedAt: Date.now(),
      planPhaseComplete: false,
      planPhaseStartedAt: null,
    }
    threadStates.set(sessionID, state)
  }
  return state
}

export function recordDecision(sessionID: string, decision: RoutingDecision, promptText: string): void {
  const state = getOrCreateThreadState(sessionID)
  state.lastDecision = decision
  state.lastPromptText = promptText
  state.turnCount += 1
  state.lastUpdatedAt = Date.now()

  // opus-plan state machine: when we pick opus-plan for the first time,
  // start the plan phase (Opus active).
  if (decision.tier === "opus-plan" && state.planPhaseStartedAt === null) {
    state.planPhaseStartedAt = Date.now()
    state.planPhaseComplete = false
  }
}

/**
 * Mark the opus-plan phase complete — subsequent turns will route to
 * Sonnet for execution. Triggered when:
 *   (a) the assistant emits the first edit/write tool call, OR
 *   (b) the user explicitly runs `/execute` slash command.
 */
export function completePlanPhase(sessionID: string): void {
  const state = threadStates.get(sessionID)
  if (!state) return
  state.planPhaseComplete = true
}

export function resetPlanPhase(sessionID: string): void {
  const state = threadStates.get(sessionID)
  if (!state) return
  state.planPhaseComplete = false
  state.planPhaseStartedAt = null
}

/**
 * Clear a session's state. Called on session.deleted and session.compacted.
 */
export function clearThreadState(sessionID: string): void {
  threadStates.delete(sessionID)
}

/**
 * For testing/debugging.
 */
export function listThreadStates(): ThreadState[] {
  return Array.from(threadStates.values())
}
