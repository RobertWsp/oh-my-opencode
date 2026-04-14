import type { RoutingDecision, Tier } from "../types"

/**
 * Format a routing decision for the TUI status line. Compact, one-line.
 *
 * Examples:
 *   "opus ← specialized_domain_impl (0.94)"
 *   "sonnet ← default"
 *   "opus-plan/plan ← complex_refactor"
 *   "opus-plan/execute ← first_edit_detected"
 */
export function formatStatusLine(decision: RoutingDecision): string {
  const tier = decision.tier
  const primaryReason = pickPrimaryReason(decision.reasons)
  const confidence = decision.confidence > 0 ? ` (${decision.confidence.toFixed(2)})` : ""

  let label: string = tier
  if (tier === "opus-plan") {
    // decision.modelID distinguishes phase at resolve time
    const phase = decision.modelID.includes("opus") ? "plan" : "execute"
    label = `opus-plan/${phase}`
  }

  return `${label} ← ${primaryReason}${confidence}`
}

function pickPrimaryReason(reasons: string[]): string {
  if (reasons.length === 0) return "default"
  // Strip any tier prefix ("opus:", "sonnet:", etc.) and return the first
  const first = reasons[0] ?? "default"
  const colon = first.indexOf(":")
  if (colon > 0) {
    return first.slice(colon + 1)
  }
  return first
}

/**
 * Short tier-only badge for dense UI spots.
 * "◆ opus" | "◇ sonnet" | "· haiku" | "◆/◇ opus-plan"
 */
export function tierBadge(tier: Tier): string {
  switch (tier) {
    case "opus":
      return "◆ opus"
    case "sonnet":
      return "◇ sonnet"
    case "haiku":
      return "· haiku"
    case "opus-plan":
      return "◆/◇ opus-plan"
  }
}
