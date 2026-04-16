import { describe, it, expect } from "bun:test"
import { decideExecutionPlan } from "../subagent-decision"
import type { RoutingContext, RoutingDecision, TaskAnalysis } from "../../types"

function makeAnalysis(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    task_type: "standard_implementation",
    task_type_evidence: "e",
    reasoning_depth: "shallow",
    reasoning_depth_evidence: "e",
    scope_breadth: "single_file",
    estimated_files_touched: 1,
    context_requirements: "minimal",
    ambiguity: "specific",
    ambiguity_reasons: [],
    risk_level: "low",
    risk_justification: "isolated",
    novelty: "standard",
    detected_technologies: [],
    domain_expertise: "generic",
    iteration_profile: "single_shot",
    recommended_model: "haiku",
    confidence: 0.9,
    primary_reasoning: "trivial",
    contrarian_check: "none",
    ...overrides,
  }
}

function makeDecision(analysis: TaskAnalysis | null, overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    timestamp: Date.now(),
    sessionID: "ses_test",
    turnNumber: 1,
    agent: "build",
    tier: overrides.tier ?? "haiku",
    modelID: "claude-haiku-4-5-20251001",
    providerID: "anthropic",
    reasons: overrides.reasons ?? ["haiku:all_minimalist_conditions_met"],
    analysis,
    analyzer: {
      used: true,
      durationMs: 100,
      model: "claude-sonnet-4-6",
      fallbackUsed: false,
      cached: false,
    },
    confidence: analysis?.confidence ?? 0,
    ...overrides,
  }
}

function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    sessionID: "ses_test",
    turnNumber: 1,
    agent: "build",
    currentModel: { providerID: "anthropic", modelID: "claude-opus-4-7" },
    userPromptText: "test",
    previousDecisions: [],
    contextLoad: "fresh",
    ...overrides,
  }
}

describe("decideExecutionPlan", () => {
  it("stays inline when analysis is absent (rules fallback)", () => {
    const decision = makeDecision(null)
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("inline")
    if (plan.mode === "inline") expect(plan.reason).toBe("no_analysis_rules_fallback")
  })

  it("stays inline when main session is saturated", () => {
    const decision = makeDecision(makeAnalysis())
    const plan = decideExecutionPlan({ decision, ctx: makeCtx({ contextLoad: "saturated" }) })
    expect(plan.mode).toBe("inline")
  })

  it("stays inline when risk is critical", () => {
    const decision = makeDecision(makeAnalysis({ risk_level: "critical" }))
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("inline")
    if (plan.mode === "inline") expect(plan.reason).toBe("risk_critical")
  })

  it("stays inline when context is repo_wide", () => {
    const decision = makeDecision(makeAnalysis({ context_requirements: "repo_wide" }))
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("inline")
    if (plan.mode === "inline") expect(plan.reason).toBe("context_repo_wide")
  })

  it("stays inline for long_session iteration without explicit intent", () => {
    const decision = makeDecision(makeAnalysis({ iteration_profile: "long_session" }))
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("inline")
  })

  it("spawns for a trivial single-shot task", () => {
    const decision = makeDecision(makeAnalysis())
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("spawn")
    if (plan.mode === "spawn") {
      expect(plan.tier).toBe("haiku")
      expect(plan.reasoning).toBe("shallow")
    }
  })

  it("honors explicit commit_push intent → haiku, spawn, no escalation", () => {
    const decision = makeDecision(
      makeAnalysis({
        task_type: "simple_edit",
        detected_intent: "commit_push",
      }),
    )
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("spawn")
    if (plan.mode === "spawn") {
      expect(plan.tier).toBe("haiku")
      expect(plan.reasoning).toBe("none")
      expect(plan.allow_escalation).toBe(false)
      expect(plan.intent).toBe("commit_push")
    }
  })

  it("honors merge_complex intent → sonnet, spawn, escalation to opus", () => {
    const decision = makeDecision(
      makeAnalysis({
        task_type: "complex_refactor",
        detected_intent: "merge_complex",
        scope_breadth: "multi_file_same_module",
        iteration_profile: "short_dialog",
      }),
    )
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("spawn")
    if (plan.mode === "spawn") {
      expect(plan.tier).toBe("sonnet")
      expect(plan.reasoning).toBe("medium")
      expect(plan.allow_escalation).toBe(true)
      expect(plan.escalation_target).toBe("opus")
    }
  })

  it("keeps refactor_architectural inline (opus-plan pattern)", () => {
    const decision = makeDecision(
      makeAnalysis({
        task_type: "complex_refactor",
        detected_intent: "refactor_architectural",
        iteration_profile: "long_session",
        scope_breadth: "cross_module",
      }),
    )
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    expect(plan.mode).toBe("inline")
    if (plan.mode === "inline") expect(plan.intent).toBe("refactor_architectural")
  })

  it("enables escalation for low-confidence spawns", () => {
    const decision = makeDecision(
      makeAnalysis({
        complexity_uncertainty: "low_confidence",
        ambiguity: "ambiguous",
        ambiguity_reasons: ["scope unclear"],
      }),
    )
    const plan = decideExecutionPlan({ decision, ctx: makeCtx() })
    // may be inline due to ambiguity, but if spawn, escalation must be on
    if (plan.mode === "spawn") expect(plan.allow_escalation).toBe(true)
  })
})
