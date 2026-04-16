import { describe, it, expect } from "bun:test"
import { resolveSubagentFields } from "../subagent-fields"
import type { TaskAnalysis } from "../../types"

function mk(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    task_type: "standard_implementation",
    task_type_evidence: "x",
    reasoning_depth: "medium",
    reasoning_depth_evidence: "x",
    scope_breadth: "single_file",
    estimated_files_touched: 1,
    context_requirements: "moderate",
    ambiguity: "clear",
    ambiguity_reasons: [],
    risk_level: "low",
    risk_justification: "x",
    novelty: "standard",
    detected_technologies: [],
    domain_expertise: "generic",
    iteration_profile: "single_shot",
    recommended_model: "sonnet",
    confidence: 0.85,
    primary_reasoning: "x",
    contrarian_check: "x",
    ...overrides,
  }
}

describe("resolveSubagentFields", () => {
  it("falls back to base-derived defaults when fields are absent", () => {
    const r = resolveSubagentFields(mk())
    expect(r.subagent_suitable).toBe(true)
    expect(r.complexity_uncertainty).toBe("high_confidence")
    expect(r.detected_intent).toBeNull()
  })

  it("marks not_suitable when iteration is marathon", () => {
    const r = resolveSubagentFields(mk({ iteration_profile: "marathon" }))
    expect(r.subagent_suitable).toBe(false)
    expect(r.subagent_isolation_reason).toContain("iteration")
  })

  it("marks not_suitable when context is repo_wide", () => {
    const r = resolveSubagentFields(mk({ context_requirements: "repo_wide" }))
    expect(r.subagent_suitable).toBe(false)
    expect(r.subagent_isolation_reason).toContain("context")
  })

  it("marks not_suitable when risk is critical", () => {
    const r = resolveSubagentFields(mk({ risk_level: "critical" }))
    expect(r.subagent_suitable).toBe(false)
  })

  it("marks not_suitable for architectural or planning task_type", () => {
    const r1 = resolveSubagentFields(mk({ task_type: "architectural" }))
    const r2 = resolveSubagentFields(mk({ task_type: "planning" }))
    expect(r1.subagent_suitable).toBe(false)
    expect(r2.subagent_suitable).toBe(false)
  })

  it("low_confidence when ambiguity is ambiguous", () => {
    const r = resolveSubagentFields(
      mk({ ambiguity: "ambiguous", ambiguity_reasons: ["scope unclear"] }),
    )
    expect(r.complexity_uncertainty).toBe("low_confidence")
  })

  it("medium_confidence when novelty is novel", () => {
    const r = resolveSubagentFields(mk({ novelty: "novel" }))
    expect(r.complexity_uncertainty).toBe("medium_confidence")
  })

  it("respects explicit fields when provided", () => {
    const r = resolveSubagentFields(
      mk({
        subagent_suitable: false,
        subagent_isolation_reason: "custom reason",
        complexity_uncertainty: "low_confidence",
        uncertainty_reason: "custom uncertainty",
        detected_intent: "merge_simple",
      }),
    )
    expect(r.subagent_suitable).toBe(false)
    expect(r.subagent_isolation_reason).toBe("custom reason")
    expect(r.complexity_uncertainty).toBe("low_confidence")
    expect(r.detected_intent).toBe("merge_simple")
  })
})
