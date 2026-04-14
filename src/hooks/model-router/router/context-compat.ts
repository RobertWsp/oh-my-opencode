/**
 * Context compatibility guard — prevents the router from selecting a
 * model whose effective context window can't hold the session's current
 * accumulated tokens.
 *
 * The bug: session accumulates ~700k tokens on Opus 4.6 (1M context via
 * Max), user sends a follow-up, router picks Sonnet 4.6. Sonnet declares
 * 1M context but via Max the 1M beta isn't active by default, so effective
 * limit is 200k → compaction fails with "exceeds model context limit".
 *
 * Solution: before honoring a downgrade, check the target model's
 * EFFECTIVE context limit (not declared). If current tokens exceed it,
 * reject the downgrade and keep the current model.
 */

import type { Tier } from "../types"

/**
 * Effective context limits under the Claude Max subscription path.
 *
 * Claude Max includes 1M context for Opus (via the anthropic_1m_context
 * flag set automatically). Sonnet also supports 1M but requires an
 * explicit beta header (context-1m-2025-08-07). Meridian does NOT always
 * forward this header, so Sonnet's effective limit is 200k in practice.
 *
 * Haiku 4.5 never supports 1M — it's 200k max.
 *
 * These numbers are conservative (lower bound of what will reliably work
 * in a single API call including output tokens).
 */
const EFFECTIVE_LIMITS: Record<Tier, number> = {
  opus: 1_000_000,
  "opus-plan": 1_000_000,
  sonnet: 200_000,
  haiku: 200_000,
}

/**
 * Safety margin — we don't want to fill the context exactly to the limit
 * because we still need room for the response and thinking tokens.
 */
const SAFETY_MARGIN = 0.85

export interface CompatibilityCheck {
  compatible: boolean
  targetLimit: number
  usableLimit: number
  currentTokens: number
  reason: string
}

/**
 * Check if a target tier can hold the current accumulated tokens.
 */
export function checkContextCompatibility(
  targetTier: Tier,
  currentTotalInputTokens: number,
): CompatibilityCheck {
  const targetLimit = EFFECTIVE_LIMITS[targetTier]
  const usableLimit = Math.floor(targetLimit * SAFETY_MARGIN)

  if (currentTotalInputTokens <= usableLimit) {
    return {
      compatible: true,
      targetLimit,
      usableLimit,
      currentTokens: currentTotalInputTokens,
      reason: `${currentTotalInputTokens}tok fits in ${targetTier}(${usableLimit}tok usable)`,
    }
  }

  return {
    compatible: false,
    targetLimit,
    usableLimit,
    currentTokens: currentTotalInputTokens,
    reason: `INCOMPATIBLE: ${currentTotalInputTokens}tok > ${targetTier}(${usableLimit}tok usable)`,
  }
}

/**
 * Given a desired target tier and a minimum required token capacity,
 * return the smallest tier that can hold the tokens (no-op if target
 * already fits, upgrade if not).
 *
 * Returns null if nothing fits (which shouldn't happen since Opus=1M).
 */
export function pickCompatibleTier(
  desiredTier: Tier,
  currentTotalInputTokens: number,
): Tier | null {
  // If desired fits, use it
  if (checkContextCompatibility(desiredTier, currentTotalInputTokens).compatible) {
    return desiredTier
  }

  // Walk up the hierarchy: haiku/sonnet(200k) → opus(1M)
  // If we're downgrading from opus to sonnet/haiku and it doesn't fit,
  // we must stay on opus.
  if (desiredTier === "haiku" || desiredTier === "sonnet") {
    // Check opus
    if (checkContextCompatibility("opus", currentTotalInputTokens).compatible) {
      return "opus"
    }
  }

  // Nothing fits (catastrophic — more than 850k tokens)
  return null
}
