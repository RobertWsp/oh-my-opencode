import { getAgentConfigKey } from "../../../shared/agent-display-names"
import { AGENT_TIER_OVERRIDES, MODEL_IDS } from "../constants"
import type { RoutingContext, RoutingDecision, TaskAnalysis, Tier, ThreadState } from "../types"

/**
 * Deterministic decision matrix. The analyzer produces a structured
 * TaskAnalysis; this function applies explicit rules to pick a tier.
 *
 * Design:
 *   1. Agent override (highest precedence)
 *   2. Opus triggers (any one match)
 *   3. opus-plan upgrade (opus + long_session)
 *   4. Haiku triggers (ALL must match)
 *   5. Confidence escalation (low confidence → escalate haiku to sonnet)
 *   6. Ambiguity escalation (ambiguous/vague non-question → escalate haiku)
 *   7. Default: sonnet
 */

export interface DecisionMatrixOptions {
  agentOverrides?: Record<string, Tier>
  enableOpusPlan?: boolean
}

export interface DecisionResult {
  tier: Tier
  reasons: string[]
}

export function decideFromAnalysis(
  analysis: TaskAnalysis,
  ctx: RoutingContext,
  opts: DecisionMatrixOptions = {},
): DecisionResult {
  const reasons: string[] = []
  const overrides = { ...AGENT_TIER_OVERRIDES, ...(opts.agentOverrides ?? {}) }
  const enableOpusPlan = opts.enableOpusPlan ?? true

  // ─── Rule 1: Agent override (highest precedence) ──────────────────────
  // Normalize the agent name: the TUI/SDK passes display names like
  // "Sisyphus (Ultraworker)" or "Atlas (Plan Executor)", but the override
  // map is keyed by lowercase config keys ("sisyphus", "atlas"). Use the
  // shared resolver that handles both forms case-insensitively.
  const agentKey = getAgentConfigKey(ctx.agent)
  const agentForced = overrides[agentKey]
  if (agentForced) {
    reasons.push(`agent:${agentKey}→${agentForced}`)
    return { tier: agentForced, reasons }
  }

  // ─── Rule 2: Opus triggers ────────────────────────────────────────────
  const opusRules: Array<{ cond: boolean; reason: string }> = [
    {
      cond: ["architectural", "complex_refactor", "research"].includes(analysis.task_type),
      reason: `task_type=${analysis.task_type}`,
    },
    {
      cond: ["deep", "exhaustive"].includes(analysis.reasoning_depth),
      reason: `reasoning_depth=${analysis.reasoning_depth}`,
    },
    {
      cond: ["cross_module", "system_wide"].includes(analysis.scope_breadth),
      reason: `scope_breadth=${analysis.scope_breadth}`,
    },
    {
      cond: ["novel", "unprecedented"].includes(analysis.novelty),
      reason: `novelty=${analysis.novelty}`,
    },
    {
      cond: analysis.risk_level === "critical",
      reason: "risk=critical",
    },
    {
      cond: analysis.domain_expertise === "specialized" && analysis.task_type !== "question_answer",
      reason: "specialized_domain_impl",
    },
  ]

  for (const rule of opusRules) {
    if (rule.cond) {
      reasons.push(`opus:${rule.reason}`)

      // ─── Rule 3: opus-plan upgrade ─────────────────────────────────
      // If the task will span many turns, use opus-plan pattern:
      // Opus for the planning phase, Sonnet for execution.
      if (
        enableOpusPlan &&
        ["long_session", "marathon"].includes(analysis.iteration_profile) &&
        ["complex_refactor", "architectural"].includes(analysis.task_type)
      ) {
        reasons.push(`opus-plan:iter=${analysis.iteration_profile}`)
        return { tier: "opus-plan", reasons }
      }

      return { tier: "opus", reasons }
    }
  }

  // ─── Rule 4: Haiku triggers (all conditions) ──────────────────────────
  // Note: ambiguity accepts both "specific" and "clear" because "clear"
  // just means minor interpretation needed (e.g. "fix the typo" — clear
  // intent, file unspecified). Only "ambiguous"/"vague" escalate.
  const haikuConditions = [
    {
      cond: ["trivial_lookup", "simple_edit", "question_answer"].includes(analysis.task_type),
      label: `task_type=${analysis.task_type}`,
    },
    {
      cond: ["none", "shallow"].includes(analysis.reasoning_depth),
      label: `depth=${analysis.reasoning_depth}`,
    },
    {
      cond: ["single_line", "single_file"].includes(analysis.scope_breadth),
      label: `scope=${analysis.scope_breadth}`,
    },
    { cond: analysis.context_requirements === "minimal", label: "context=minimal" },
    { cond: ["specific", "clear"].includes(analysis.ambiguity), label: `ambig=${analysis.ambiguity}` },
    { cond: analysis.risk_level === "low", label: "risk=low" },
    { cond: analysis.iteration_profile === "single_shot", label: "iter=single_shot" },
  ]

  const allHaikuMet = haikuConditions.every((c) => c.cond)
  if (allHaikuMet) {
    reasons.push("haiku:all_minimalist_conditions_met")
    return { tier: "haiku", reasons }
  }

  // ─── Rule 5: Default to Sonnet ────────────────────────────────────────
  reasons.push("sonnet:default_workhorse")

  // ─── Rule 6: Confidence escalation (guard for analyzer uncertainty) ───
  // If the analyzer is uncertain, we already default to sonnet; no extra
  // escalation needed because the default IS sonnet. This rule exists to
  // prevent a future haiku-default from being picked under low confidence.
  if (analysis.confidence < 0.6) {
    reasons.push(`note:low_confidence=${analysis.confidence.toFixed(2)}`)
  }

  return { tier: "sonnet", reasons }
}

/**
 * Resolve a tier (including virtual opus-plan) to a concrete
 * providerID+modelID based on thread state. opus-plan is opus until the
 * plan phase completes, then switches to sonnet.
 */
export function resolveTierToModel(
  tier: Tier,
  threadState: ThreadState | undefined,
): { tier: Tier; modelID: string; providerID: string; phase?: "plan" | "execute" } {
  if (tier === "opus-plan") {
    const phase = threadState?.planPhaseComplete ? "execute" : "plan"
    const ids = phase === "plan" ? MODEL_IDS.opus : MODEL_IDS.sonnet
    return { tier, ...ids, phase }
  }
  const ids = MODEL_IDS[tier]
  return { tier, ...ids }
}

/**
 * Build a full RoutingDecision from an analysis (or null if rules fallback).
 */
export function buildDecision(args: {
  analysis: TaskAnalysis | null
  ctx: RoutingContext
  tier: Tier
  reasons: string[]
  analyzerUsed: boolean
  analyzerDurationMs: number
  analyzerModel: string
  analyzerFallbackUsed: boolean
  cached: boolean
  analyzerError?: string
  threadState?: ThreadState
}): RoutingDecision {
  const { tier, modelID, providerID } = resolveTierToModel(args.tier, args.threadState)

  return {
    timestamp: Date.now(),
    sessionID: args.ctx.sessionID,
    turnNumber: args.ctx.turnNumber,
    agent: args.ctx.agent,
    tier,
    modelID,
    providerID,
    reasons: args.reasons,
    analysis: args.analysis,
    analyzer: {
      used: args.analyzerUsed,
      durationMs: args.analyzerDurationMs,
      model: args.analyzerModel,
      fallbackUsed: args.analyzerFallbackUsed,
      cached: args.cached,
      error: args.analyzerError,
    },
    confidence: args.analysis?.confidence ?? 0,
  }
}
