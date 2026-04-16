import { describe, it, expect } from "bun:test"
import { INTENT_MAP, resolveIntentDispatch } from "../intent-map"
import type { TaskAnalysis } from "../../types"

function mkAnalysis(intent: TaskAnalysis["detected_intent"]): TaskAnalysis {
  return {
    task_type: "simple_edit",
    task_type_evidence: "x",
    reasoning_depth: "shallow",
    reasoning_depth_evidence: "x",
    scope_breadth: "single_file",
    estimated_files_touched: 1,
    context_requirements: "minimal",
    ambiguity: "specific",
    ambiguity_reasons: [],
    risk_level: "low",
    risk_justification: "x",
    novelty: "standard",
    detected_technologies: [],
    domain_expertise: "generic",
    iteration_profile: "single_shot",
    recommended_model: "haiku",
    confidence: 0.9,
    primary_reasoning: "x",
    contrarian_check: "x",
    detected_intent: intent,
  }
}

describe("INTENT_MAP", () => {
  it("has a dispatch for every DetectedIntent except null/none", () => {
    const keys = Object.keys(INTENT_MAP).sort()
    expect(keys).toContain("commit_push")
    expect(keys).toContain("merge_simple")
    expect(keys).toContain("merge_complex")
    expect(keys).toContain("refactor_architectural")
    expect(keys).toContain("lookup_qa")
  })

  it("commit_push → haiku/none/subagent/no-escalation", () => {
    const d = INTENT_MAP.commit_push
    expect(d.tier).toBe("haiku")
    expect(d.reasoning).toBe("none")
    expect(d.prefer_subagent).toBe(true)
    expect(d.allow_escalation).toBe(false)
  })

  it("merge_complex → sonnet/medium/escalation-to-opus", () => {
    const d = INTENT_MAP.merge_complex
    expect(d.tier).toBe("sonnet")
    expect(d.reasoning).toBe("medium")
    expect(d.prefer_subagent).toBe(true)
    expect(d.allow_escalation).toBe(true)
    expect(d.escalation_target).toBe("opus")
  })

  it("refactor_architectural stays inline (opus-plan in main)", () => {
    const d = INTENT_MAP.refactor_architectural
    expect(d.prefer_subagent).toBe(false)
  })

  it("lookup_qa → haiku, inline (Q&A is main dialog)", () => {
    const d = INTENT_MAP.lookup_qa
    expect(d.tier).toBe("haiku")
    expect(d.prefer_subagent).toBe(false)
  })
})

describe("resolveIntentDispatch", () => {
  it("returns null when intent is null", () => {
    expect(resolveIntentDispatch(mkAnalysis(null))).toBeNull()
  })

  it("returns dispatch for a known intent", () => {
    const d = resolveIntentDispatch(mkAnalysis("commit_push"))
    expect(d).not.toBeNull()
    expect(d?.tier).toBe("haiku")
  })
})
