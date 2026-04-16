import type { RoutingContext, RoutingDecision, TaskAnalysis, Tier } from "../types"
import { resolveSubagentFields } from "../analyzer/subagent-fields"
import { resolveIntentDispatch, type IntentDispatch } from "./intent-map"

/**
 * Decision: should this routing outcome be executed inline (swap the main
 * session's model) or spawned as an isolated subagent?
 *
 * Motivation: switching the main session's model invalidates the prompt
 * cache (cache is keyed by model + session). Spawning an isolated subagent
 * creates a new session with its own cache key — the main session's cache
 * is preserved. The subagent's result is returned verbatim to the main as
 * a tool_result, with no cross-contamination.
 *
 * Pipeline (first match wins):
 *   1. Explicit intent says otherwise (e.g. refactor_architectural stays inline)
 *   2. Context load too heavy → stay inline (history matters)
 *   3. Multi-turn iteration → stay inline
 *   4. subagent_suitable === false → stay inline
 *   5. Otherwise → spawn
 */

export interface SpawnPlan {
  mode: "spawn"
  tier: Tier
  reasoning: "none" | "shallow" | "medium" | "deep" | "exhaustive"
  allow_escalation: boolean
  escalation_target: Tier | undefined
  reason: string
  label: string
  intent: string | null
}

export interface InlinePlan {
  mode: "inline"
  reason: string
  intent: string | null
}

export type ExecutionPlan = SpawnPlan | InlinePlan

export function decideExecutionPlan(args: {
  decision: RoutingDecision
  ctx: RoutingContext
}): ExecutionPlan {
  const { decision, ctx } = args
  const analysis = decision.analysis

  // No analysis ⇒ rules fallback ⇒ conservative inline
  if (!analysis) {
    return { mode: "inline", reason: "no_analysis_rules_fallback", intent: null }
  }

  const fields = resolveSubagentFields(analysis)
  const intent = resolveIntentDispatch(analysis)
  const intentName = intent ? (analysis.detected_intent as string) : null

  // Guard 1: main session is saturated — spawning a subagent wouldn't help
  // the compaction problem, and the task likely depends on history.
  if (ctx.contextLoad === "saturated") {
    return { mode: "inline", reason: "context_saturated_prefer_inline", intent: intentName }
  }

  // Guard 2: explicit intent says stay inline
  if (intent && !intent.prefer_subagent) {
    return { mode: "inline", reason: `intent:${intentName}:inline`, intent: intentName }
  }

  // Guard 3: iteration profile is long_session/marathon and no explicit
  // intent override — history is load-bearing.
  if (
    !intent &&
    (analysis.iteration_profile === "long_session" || analysis.iteration_profile === "marathon")
  ) {
    return { mode: "inline", reason: `iteration_${analysis.iteration_profile}`, intent: intentName }
  }

  // Guard 4: critical risk — main session should own the decision flow.
  if (analysis.risk_level === "critical") {
    return { mode: "inline", reason: "risk_critical", intent: intentName }
  }

  // Guard 5: repo_wide context — shouldn't re-explore in a subagent.
  if (analysis.context_requirements === "repo_wide") {
    return { mode: "inline", reason: "context_repo_wide", intent: intentName }
  }

  // Guard 6: analyzer said it's not subagent_suitable
  if (!fields.subagent_suitable) {
    return { mode: "inline", reason: `analyzer:not_suitable:${fields.subagent_isolation_reason}`, intent: intentName }
  }

  // Spawn path — intent values take precedence over analysis-derived defaults
  const tier = (intent?.tier ?? decision.tier) as Tier
  const reasoning = intent?.reasoning ?? mapReasoningFromAnalysis(analysis)
  const allow_escalation =
    intent?.allow_escalation ?? shouldAllowEscalation(analysis, fields.complexity_uncertainty)
  const escalation_target = intent?.escalation_target ?? defaultEscalationTarget(tier)
  const label = intent?.label ?? buildDerivedLabel(analysis, tier)

  return {
    mode: "spawn",
    tier,
    reasoning,
    allow_escalation,
    escalation_target,
    reason: intent ? `intent:${intentName}:spawn` : "analyzer:spawn_eligible",
    label,
    intent: intentName,
  }
}

function mapReasoningFromAnalysis(a: TaskAnalysis): "none" | "shallow" | "medium" | "deep" | "exhaustive" {
  return a.reasoning_depth
}

function shouldAllowEscalation(a: TaskAnalysis, uncertainty: string): boolean {
  if (uncertainty === "low_confidence") return true
  if (a.ambiguity === "ambiguous" || a.ambiguity === "vague") return true
  if (a.novelty === "novel" || a.novelty === "unprecedented") return true
  return false
}

function defaultEscalationTarget(tier: Tier): Tier | undefined {
  if (tier === "haiku") return "sonnet"
  if (tier === "sonnet") return "opus"
  return undefined
}

function buildDerivedLabel(a: TaskAnalysis, tier: Tier): string {
  return `${tier} · ${a.task_type} · ${a.scope_breadth}`
}
