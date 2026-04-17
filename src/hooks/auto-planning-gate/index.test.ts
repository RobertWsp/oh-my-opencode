import { describe, expect, test, beforeEach, mock } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import { createAutoPlanningGateHook } from "./index"
import type { TaskAnalysis } from "../model-router/types"

/**
 * Unit tests for auto-planning-gate.
 *
 * Tests focus on gate logic after the analyzer returns — the runAnalyzer
 * call itself is mocked. Tests mirror the real OpenCode chat.message
 * handler contract: { sessionID, agent } + { parts: [{type,text}] }.
 *
 * Covers:
 * - Runs analyzer only on first turn of a session (analyzed flag)
 * - Skips when user text is empty or contains gate marker (self-injection)
 * - Injects Prometheus directive when task merits planning
 * - Does NOT inject for trivial / simple_edit / question_answer
 * - Respects disabledAgents
 * - Clears session state on session.deleted/compacted
 * - Survives analyzer failures without crashing
 */

type ClientSession = PluginInput["client"]["session"]

function makeCtx(promptCalls: Array<{ sessionID: string; text: string }>) {
  const session: Partial<ClientSession> & {
    promptAsync: (args: {
      path: { id: string }
      body: { parts: Array<{ type: string; text?: string }> }
      query?: { directory?: string }
    }) => Promise<unknown>
  } = {
    promptAsync: async (args) => {
      const text = args.body.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text ?? "")
        .join("")
      promptCalls.push({ sessionID: args.path.id, text })
      return { ok: true }
    },
  }
  // Isolated tmpdir per test ctx so persistSession's state file doesn't
  // bleed across tests.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auto-plan-gate-test-"))
  return {
    directory,
    client: { session } as unknown as PluginInput["client"],
  }
}

/**
 * Mock runAnalyzer by overriding the exported symbol on the module.
 * This uses Bun's mock API to replace the function at runtime.
 */
const mockAnalysis = (overrides: Partial<TaskAnalysis>): TaskAnalysis => {
  const base: TaskAnalysis = {
    task_type: "simple_edit",
    task_type_evidence: "user asked for a simple change",
    reasoning_depth: "shallow",
    reasoning_depth_evidence: "direct edit",
    scope_breadth: "single_file",
    estimated_files_touched: 1,
    context_requirements: "minimal",
    ambiguity: "specific",
    ambiguity_reasons: [],
    risk_level: "low",
    risk_justification: "no external impact",
    novelty: "standard",
    detected_technologies: [],
    domain_expertise: "general",
    iteration_profile: "single_shot",
    recommended_model: "haiku",
    confidence: 0.9,
    primary_reasoning: "simple task",
    contrarian_check: "could be medium if tests fail",
  }
  return { ...base, ...overrides }
}

let mockRunAnalyzerResult: {
  ok: boolean
  analysis: TaskAnalysis | null
  durationMs?: number
  error?: string
} = { ok: false, analysis: null }

// Replace runAnalyzer across the module boundary. We mock the module
// that auto-planning-gate imports from.
await mock.module("../model-router/analyzer/run-analyzer", () => ({
  runAnalyzer: async () => mockRunAnalyzerResult,
}))

describe("auto-planning-gate", () => {
  let promptCalls: Array<{ sessionID: string; text: string }>

  beforeEach(() => {
    promptCalls = []
    mockRunAnalyzerResult = { ok: false, analysis: null }
  })

  test("injects Prometheus directive for architectural tasks", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({
        task_type: "architectural",
        scope_breadth: "cross_module",
        risk_level: "high",
      }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Redesign auth to use JWT" }],
    })

    // Fire-and-forget — await the actual analyze result
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(1)
    expect(promptCalls[0].sessionID).toBe("ses_1")
    expect(promptCalls[0].text).toContain("<auto_planning_gate>")
    expect(promptCalls[0].text).toContain('subagent_type: "prometheus"')
    expect(promptCalls[0].text).toContain("task_type=architectural")
    // user text must be wrapped in <user_brief> with the fast-path marker
    // so Prometheus skips Interview Mode.
    expect(promptCalls[0].text).toContain("<user_brief>")
    expect(promptCalls[0].text).toContain("[AUTO_PLANNING_GATE_FORWARDED_REQUEST]")
    expect(promptCalls[0].text).toContain("Redesign auth to use JWT")
  })

  test("injects for complex_refactor", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "complex_refactor" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Refactor all services" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(1)
  })

  test("injects for planning task_type", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "planning" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Plan the migration" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(1)
  })

  test("SKIPS for simple_edit", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "simple_edit" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "fix typo in README" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(0)
  })

  test("SKIPS for trivial_lookup", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "trivial_lookup" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "what is X?" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(0)
  })

  test("SKIPS for question_answer", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "question_answer" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "how does this work?" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(0)
  })

  test("INJECTS standard_implementation when scope=cross_module + high risk", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({
        task_type: "standard_implementation",
        scope_breadth: "cross_module",
        reasoning_depth: "deep",
        risk_level: "high",
        estimated_files_touched: 6,
      }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Implement across services" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(1)
  })

  test("SKIPS standard_implementation when low risk + same module", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({
        task_type: "standard_implementation",
        scope_breadth: "multi_file_same_module",
        reasoning_depth: "shallow",
        risk_level: "low",
        estimated_files_touched: 2,
      }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Add validation to 2 files" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(promptCalls.length).toBe(0)
  })

  test("runs analyzer ONLY once per session (analyzed flag)", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "architectural" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    const call = () =>
      hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
        parts: [{ type: "text", text: "Redesign auth" }],
      })

    await call()
    await new Promise((r) => setTimeout(r, 30))
    await call() // second turn should not re-analyze
    await new Promise((r) => setTimeout(r, 30))

    expect(promptCalls.length).toBe(1)
  })

  test("skips self-injection (defensive)", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "architectural" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [
        {
          type: "text",
          text: "<auto_planning_gate>something was already injected</auto_planning_gate>",
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(promptCalls.length).toBe(0)
  })

  test("respects disabledAgents", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "architectural" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({
      ctx,
      config: { disabledAgents: ["prometheus", "momus"] },
    })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "prometheus" }, {
      parts: [{ type: "text", text: "Plan this" }],
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(promptCalls.length).toBe(0)
  })

  test("honours enabled=false", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "architectural" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({
      ctx,
      config: { enabled: false },
    })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Redesign auth" }],
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(promptCalls.length).toBe(0)
  })

  test("survives analyzer failure without crash", async () => {
    mockRunAnalyzerResult = { ok: false, analysis: null, error: "timeout" }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Redesign auth" }],
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(promptCalls.length).toBe(0)
  })

  test("clears session state on session.deleted", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "architectural" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })

    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Redesign auth" }],
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(promptCalls.length).toBe(1)

    await hook.event({
      event: { type: "session.deleted", properties: { info: { id: "ses_1" } } },
    })

    // After session.deleted, same sessionID should analyze again
    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Redesign auth again" }],
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(promptCalls.length).toBe(2)
  })

  test("skips on empty parts", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createAutoPlanningGateHook({ ctx })
    await hook["chat.message"]({ sessionID: "ses_1", agent: "primary" }, { parts: [] })
    await new Promise((r) => setTimeout(r, 30))
    expect(promptCalls.length).toBe(0)
  })

  test("persisted state: second hook instance skips previously-analyzed session", async () => {
    mockRunAnalyzerResult = {
      ok: true,
      analysis: mockAnalysis({ task_type: "architectural" }),
      durationMs: 100,
    }
    const ctx = makeCtx(promptCalls)
    const hook1 = createAutoPlanningGateHook({ ctx })

    await hook1["chat.message"]({ sessionID: "ses_persist_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Redesign X" }],
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(promptCalls.length).toBe(1)

    // Simulate a new process: create a fresh hook instance against the
    // same ctx directory. The persisted state file should cause the
    // session to be marked pre-analyzed, skipping re-injection.
    const freshPromptCalls: Array<{ sessionID: string; text: string }> = []
    const ctx2 = {
      directory: ctx.directory, // same directory → same state file
      client: makeCtx(freshPromptCalls).client,
    }
    const hook2 = createAutoPlanningGateHook({ ctx: ctx2 })

    await hook2["chat.message"]({ sessionID: "ses_persist_1", agent: "primary" }, {
      parts: [{ type: "text", text: "Redesign X again" }],
    })
    await new Promise((r) => setTimeout(r, 50))

    // freshPromptCalls should be empty — session was already analyzed.
    expect(freshPromptCalls.length).toBe(0)
  })
})
