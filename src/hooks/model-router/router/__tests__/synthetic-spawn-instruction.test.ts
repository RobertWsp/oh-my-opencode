import { describe, it, expect } from "bun:test"
import {
  buildSyntheticSpawnInstruction,
  pickSubagentType,
  tierToForkTier,
} from "../synthetic-spawn-instruction"
import type { TaskAnalysis } from "../../types"
import type { SpawnPlan } from "../subagent-decision"

function mkAnalysis(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
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
    confidence: 0.95,
    primary_reasoning: "x",
    contrarian_check: "x",
    ...overrides,
  }
}

function mkPlan(overrides: Partial<SpawnPlan> = {}): SpawnPlan {
  return {
    mode: "spawn",
    tier: "haiku",
    reasoning: "none",
    allow_escalation: false,
    escalation_target: undefined,
    reason: "intent:commit_push:spawn",
    label: "commit+push (mechanical git ops)",
    intent: "commit_push",
    ...overrides,
  }
}

describe("tierToForkTier", () => {
  it("maps haiku → budget", () => expect(tierToForkTier("haiku")).toBe("budget"))
  it("maps sonnet → balanced", () => expect(tierToForkTier("sonnet")).toBe("balanced"))
  it("maps opus → quality", () => expect(tierToForkTier("opus")).toBe("quality"))
  it("maps opus-plan → quality (planning phase)", () => expect(tierToForkTier("opus-plan")).toBe("quality"))
})

describe("pickSubagentType", () => {
  it("picks explore for research", () => {
    expect(pickSubagentType(mkAnalysis({ task_type: "research" }))).toBe("explore")
  })
  it("picks explore for trivial_lookup", () => {
    expect(pickSubagentType(mkAnalysis({ task_type: "trivial_lookup" }))).toBe("explore")
  })
  it("defaults to general", () => {
    expect(pickSubagentType(mkAnalysis({ task_type: "simple_edit" }))).toBe("general")
    expect(pickSubagentType(mkAnalysis({ task_type: "complex_refactor" }))).toBe("general")
  })
})

describe("buildSyntheticSpawnInstruction", () => {
  const sample = {
    originalUserMessage: "commit and push the recent changes",
    plan: mkPlan(),
    analysis: mkAnalysis(),
    parent: {
      sessionID: "ses_main",
      modelID: "claude-opus-4-7",
      providerID: "anthropic",
      cwd: "/home/user/repo",
    },
  }

  it("includes the router_directive wrapper", () => {
    const out = buildSyntheticSpawnInstruction(sample)
    expect(out).toContain("<router_directive>")
    expect(out).toContain("</router_directive>")
  })

  it("instructs to invoke the task tool", () => {
    const out = buildSyntheticSpawnInstruction(sample)
    expect(out).toContain("INVOKE the task tool")
  })

  it("emits the chosen tier with fork enum", () => {
    const out = buildSyntheticSpawnInstruction(sample)
    expect(out).toContain(`tier: "budget"`)
  })

  it("emits the chosen subagent_type", () => {
    const out = buildSyntheticSpawnInstruction(sample)
    expect(out).toContain(`subagent_type: "general"`)
  })

  it("emits research → explore subagent_type", () => {
    const out = buildSyntheticSpawnInstruction({
      ...sample,
      analysis: mkAnalysis({ task_type: "research" }),
    })
    expect(out).toContain(`subagent_type: "explore"`)
  })

  it("includes the intent and reasoning hints when present", () => {
    const out = buildSyntheticSpawnInstruction({
      ...sample,
      plan: mkPlan({ reasoning: "medium", intent: "merge_complex" }),
    })
    expect(out).toContain("[intent: merge_complex]")
    expect(out).toContain("[reasoning: medium]")
  })

  it("contains the original user request inside the prompt block", () => {
    const out = buildSyntheticSpawnInstruction(sample)
    expect(out).toContain("commit and push the recent changes")
  })

  it("documents the escalation retry path", () => {
    const out = buildSyntheticSpawnInstruction({
      ...sample,
      plan: mkPlan({
        tier: "sonnet",
        allow_escalation: true,
        escalation_target: "opus",
        intent: "merge_complex",
        label: "merge complex",
      }),
    })
    expect(out).toContain("escalation")
    expect(out).toContain("balanced → escalate=quality")
  })
})
