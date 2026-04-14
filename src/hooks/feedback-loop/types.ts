import type { RoutingDecision, RoutingOutcome } from "../model-router/types"

/**
 * Per-session feedback state. Holds the last routing decision for joining
 * with outcome signals when the session idles.
 */
export interface SessionFeedback {
  sessionID: string
  lastDecision: RoutingDecision | null
  signals: FeedbackSignals
  // Dedup / coalescing
  lastIdleAt: number
  lastOutcomeFlushedAt: number
}

export interface FeedbackSignals {
  hasError: boolean
  errorMessage: string | null
  userFollowedUp: boolean
  followUpCategory: "continuation" | "correction" | "question" | "unknown" | null
  modelFallbackApplied: boolean
  userPinnedDifferentModel: boolean
  toolsExecutedCount: number
  completedCleanly: boolean
}

export function emptySignals(): FeedbackSignals {
  return {
    hasError: false,
    errorMessage: null,
    userFollowedUp: false,
    followUpCategory: null,
    modelFallbackApplied: false,
    userPinnedDifferentModel: false,
    toolsExecutedCount: 0,
    completedCleanly: false,
  }
}

/**
 * Map signals → [-1, 1] score.
 *
 * Design:
 *  - Positive signals add up (clean completion, no follow-up)
 *  - Negative signals subtract (error, user pinned different model)
 *  - Clamped to [-1, 1]
 *
 * The function is pure and deterministic so it can be unit tested.
 */
export function scoreOutcome(signals: FeedbackSignals): number {
  let score = 0

  // ── Positive signals
  if (signals.completedCleanly) score += 0.5
  if (signals.toolsExecutedCount > 0 && !signals.hasError) score += 0.2
  if (!signals.userFollowedUp) score += 0.3

  // ── Negative signals
  if (signals.hasError) score -= 0.5
  if (signals.userPinnedDifferentModel) score -= 0.7
  if (signals.modelFallbackApplied) score -= 0.4
  if (signals.userFollowedUp && signals.followUpCategory === "correction") score -= 0.3
  if (signals.userFollowedUp && signals.followUpCategory === "question") score -= 0.05

  return Math.max(-1, Math.min(1, score))
}

/**
 * Convert signals + score into a RoutingOutcome ready for logging.
 */
export function buildOutcome(signals: FeedbackSignals): RoutingOutcome {
  return {
    completedAt: Date.now(),
    score: scoreOutcome(signals),
    signals: {
      completedCleanly: signals.completedCleanly,
      hasError: signals.hasError,
      userFollowedUp: signals.userFollowedUp,
      followUpCategory: signals.followUpCategory ?? undefined,
      modelFallbackApplied: signals.modelFallbackApplied,
      userPinnedDifferentModel: signals.userPinnedDifferentModel,
      toolsExecutedCount: signals.toolsExecutedCount,
    },
  }
}
