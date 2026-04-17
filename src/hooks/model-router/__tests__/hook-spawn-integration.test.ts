import { describe, it, expect, beforeEach, mock } from "bun:test"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createModelRouterHook } from "../hook"
import * as runAnalyzer from "../analyzer/run-analyzer"
import * as continuationClassifier from "../analyzer/continuation-classifier"
import { defaultSpawnLogPath } from "../storage/spawn-intent-log"
import type { TaskAnalysis } from "../types"

/**
 * Integration test: drive the chat.message handler end-to-end with a mocked
 * analyzer and verify that:
 *   1. shadow mode writes a spawn intent record (no model swap)
 *   2. spawn mode writes a spawn intent + injects synthetic instruction
 *      and does NOT swap the main session's model.
 */

function mkAnalysis(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    task_type: "simple_edit",
    task_type_evidence: "commit message",
    reasoning_depth: "none",
    reasoning_depth_evidence: "trivial git op",
    scope_breadth: "single_file",
    estimated_files_touched: 1,
    context_requirements: "minimal",
    ambiguity: "specific",
    ambiguity_reasons: [],
    risk_level: "low",
    risk_justification: "no logic change",
    novelty: "standard",
    detected_technologies: ["git"],
    domain_expertise: "generic",
    iteration_profile: "single_shot",
    recommended_model: "haiku",
    confidence: 0.95,
    primary_reasoning: "git ops match haiku case",
    contrarian_check: "sonnet would overspend",
    complexity_uncertainty: "high_confidence",
    uncertainty_reason: "intent is unambiguous",
    subagent_suitable: true,
    subagent_isolation_reason: "single shot, low risk, no main state needed",
    detected_intent: "commit_push",
    ...overrides,
  }
}

describe("hook spawn integration", () => {
  let tmpDir: string
  let routingLogPath: string
  let analyzerSpy: ReturnType<typeof mock>
  let classifierSpy: ReturnType<typeof mock>

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "model-router-spawn-"))
    routingLogPath = path.join(tmpDir, "routing.jsonl")
    // The spawn intent log goes to the default path (HOME-based). For
    // assertion isolation we redirect it via XDG-style HOME override.
    process.env.HOME = tmpDir

    // Mock analyzer to return a deterministic commit_push analysis
    analyzerSpy = mock(async () => ({
      analysis: mkAnalysis(),
      durationMs: 50,
      modelUsed: "claude-sonnet-4-6",
      via: "mocked" as const,
    }))
    ;(runAnalyzer as any).runAnalyzer = analyzerSpy

    // Mock continuation classifier to always reanalyze
    classifierSpy = mock(async () => ({
      decision: "reanalyze" as const,
      intent: "new_task" as const,
      confidence: 0.9,
      reasoning: "first turn",
      ruleHit: "first_turn",
    }))
    ;(continuationClassifier as any).classifyContinuation = classifierSpy
  })

  function buildOutput() {
    return {
      message: { id: "msg_test", role: "user" } as Record<string, unknown>,
      parts: [{ type: "text", text: "commit and push the changes" }] as Array<{
        type: string
        text?: string
        synthetic?: boolean
      }>,
    }
  }

  it("shadow mode writes a spawn intent without swapping the model", async () => {
    const hook = createModelRouterHook({
      enabled: true,
      strategy: "hybrid",
      logDecisions: true,
      logPath: routingLogPath,
      subagentIsolation: { mode: "shadow", allowEscalation: true, maxEscalations: 2 },
    })

    const output = buildOutput()
    const initialModel = { providerID: "anthropic", modelID: "claude-opus-4-7" }
    output.message["model"] = initialModel

    await hook["chat.message"](
      {
        sessionID: "ses_shadow_" + Date.now(),
        agent: "build",
        model: initialModel,
      },
      output,
    )

    const spawnLog = defaultSpawnLogPath()
    if (existsSync(spawnLog)) {
      const lines = readFileSync(spawnLog, "utf8").split("\n").filter(Boolean)
      const last = lines[lines.length - 1]
      const record = JSON.parse(last)
      expect(record.mode).toBe("shadow")
      expect(record.plan.mode).toBe("spawn")
      expect(record.plan.tier).toBe("haiku")
      expect(record.plan.intent).toBe("commit_push")
    }

    // Shadow mode: model swap STILL happens (legacy inline path)
    expect((output.message["model"] as any).modelID).toContain("haiku")

    // Shadow mode: synthetic instruction must NOT be injected
    const synthetic = output.parts.filter((p: any) => p.synthetic)
    expect(synthetic.length).toBe(0)
  })

  it("spawn mode writes intent, injects synthetic instruction, preserves main model", async () => {
    const hook = createModelRouterHook({
      enabled: true,
      strategy: "hybrid",
      logDecisions: true,
      logPath: routingLogPath,
      subagentIsolation: { mode: "spawn", allowEscalation: true, maxEscalations: 2 },
    })

    const output = buildOutput()
    const initialModel = { providerID: "anthropic", modelID: "claude-opus-4-7" }
    output.message["model"] = initialModel

    await hook["chat.message"](
      {
        sessionID: "ses_spawn_" + Date.now(),
        agent: "build",
        model: initialModel,
      },
      output,
    )

    // Spawn mode: model is PRESERVED (main session keeps its cache)
    expect((output.message["model"] as any).modelID).toBe("claude-opus-4-7")

    // Spawn mode: a synthetic instruction must be injected
    const synthetic = output.parts.filter((p: any) => p.synthetic && p.type === "text")
    expect(synthetic.length).toBe(1)
    const instructionText = (synthetic[0] as any).text as string
    expect(instructionText).toContain("<router_directive>")
    expect(instructionText).toContain('tier: "budget"')
    expect(instructionText).toContain("task tool")
    expect(instructionText).toContain("commit and push")
  })
})
