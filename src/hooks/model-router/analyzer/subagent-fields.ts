import type { TaskAnalysis, ComplexityUncertainty, DetectedIntent } from "../types"

/**
 * Resolved subagent-related fields. When the analyzer does not populate them,
 * we derive sensible defaults from the 9 base dimensions so downstream rules
 * never have to branch on undefined.
 */
export interface ResolvedSubagentFields {
  complexity_uncertainty: ComplexityUncertainty
  uncertainty_reason: string
  subagent_suitable: boolean
  subagent_isolation_reason: string
  detected_intent: DetectedIntent
}

const NON_ISOLATABLE_TASK_TYPES: TaskAnalysis["task_type"][] = ["architectural", "planning"]

export function resolveSubagentFields(a: TaskAnalysis): ResolvedSubagentFields {
  const derived = deriveFromBase(a)
  return {
    complexity_uncertainty: a.complexity_uncertainty ?? derived.complexity_uncertainty,
    uncertainty_reason: a.uncertainty_reason ?? derived.uncertainty_reason,
    subagent_suitable: a.subagent_suitable ?? derived.subagent_suitable,
    subagent_isolation_reason: a.subagent_isolation_reason ?? derived.subagent_isolation_reason,
    detected_intent: (a.detected_intent as DetectedIntent) ?? derived.detected_intent,
  }
}

function deriveFromBase(a: TaskAnalysis): ResolvedSubagentFields {
  const iter = a.iteration_profile
  const ctx = a.context_requirements
  const risk = a.risk_level
  const ambig = a.ambiguity

  const isolatableIter = iter === "single_shot" || iter === "short_dialog"
  const isolatableCtx = ctx === "minimal" || ctx === "moderate"
  const isolatableRisk = risk !== "critical"
  const isolatableType = !NON_ISOLATABLE_TASK_TYPES.includes(a.task_type)
  const subagent_suitable = isolatableIter && isolatableCtx && isolatableRisk && isolatableType

  const subagent_isolation_reason = subagent_suitable
    ? `iter=${iter}, ctx=${ctx}, risk=${risk}, type=${a.task_type}`
    : `NOT suitable: ${!isolatableIter ? "iteration too long; " : ""}${
        !isolatableCtx ? "context too broad; " : ""
      }${!isolatableRisk ? "risk critical; " : ""}${!isolatableType ? `type ${a.task_type} needs main session; ` : ""}`.trim()

  // Low confidence when ambiguity is significant or novelty is high
  let complexity_uncertainty: ComplexityUncertainty = "high_confidence"
  if (ambig === "ambiguous" || ambig === "vague") complexity_uncertainty = "low_confidence"
  else if (a.novelty === "novel" || a.novelty === "unprecedented") complexity_uncertainty = "medium_confidence"
  else if (a.confidence < 0.75) complexity_uncertainty = "medium_confidence"

  const uncertainty_reason =
    complexity_uncertainty === "low_confidence"
      ? `ambiguity=${ambig}: ${a.ambiguity_reasons?.join("; ") || "unspecified"}`
      : complexity_uncertainty === "medium_confidence"
        ? `novelty=${a.novelty}, analyzer confidence=${a.confidence.toFixed(2)}`
        : "analysis is evidence-backed and unambiguous"

  return {
    complexity_uncertainty,
    uncertainty_reason,
    subagent_suitable,
    subagent_isolation_reason,
    detected_intent: null,
  }
}
