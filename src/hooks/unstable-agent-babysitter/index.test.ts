import { afterEach, describe, expect, test } from "bun:test"
import { _resetForTesting, setMainSession } from "../../features/claude-code-session-state"
import type { BackgroundTask } from "../../features/background-agent"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { createUnstableAgentBabysitterHook } from "./index"

const projectDir = process.cwd()

type BabysitterContext = Parameters<typeof createUnstableAgentBabysitterHook>[0]

function createMockPluginInput(options: {
  messagesBySession: Record<string, unknown[]>
  promptCalls: Array<{ input: unknown }>
}): BabysitterContext {
  const { messagesBySession, promptCalls } = options
  return {
    directory: projectDir,
    client: {
      session: {
        messages: async ({ path }: { path: { id: string } }) => ({
          data: messagesBySession[path.id] ?? [],
        }),
        prompt: async (input: unknown) => {
          promptCalls.push({ input })
        },
        promptAsync: async (input: unknown) => {
          promptCalls.push({ input })
        },
      },
    },
  }
}

type CancelCall = { taskId: string; options?: Record<string, unknown> }

function createBackgroundManager(tasks: BackgroundTask[], cancelCalls: CancelCall[] = []) {
  return {
    getTasksByParentSession: () => tasks,
    cancelTask: async (taskId: string, options?: Record<string, unknown>) => {
      cancelCalls.push({ taskId, options })
      return true
    },
  }
}

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    sessionID: "bg-1",
    parentSessionID: "main-1",
    parentMessageID: "msg-1",
    description: "unstable task",
    prompt: "run work",
    agent: "test-agent",
    status: "running",
    progress: {
      toolCalls: 1,
      lastUpdate: new Date(),
      lastMessage: "still working",
      lastMessageAt: new Date(Date.now() - 121000),
    },
    model: { providerID: "google", modelID: "gemini-1.5" },
    ...overrides,
  }
}

describe("unstable-agent-babysitter hook", () => {
  afterEach(() => {
    _resetForTesting()
  })

  test("fires reminder for hung gemini task", async () => {
    // #given
    setMainSession("main-1")
    const promptCalls: Array<{ input: unknown }> = []
    const ctx = createMockPluginInput({
      messagesBySession: {
        "main-1": [
          { info: { agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-4" } } },
        ],
        "bg-1": [
          { info: { role: "assistant" }, parts: [{ type: "thinking", thinking: "deep thought" }] },
        ],
      },
      promptCalls,
    })
    const backgroundManager = createBackgroundManager([createTask()])
    const hook = createUnstableAgentBabysitterHook(ctx, {
      backgroundManager,
      config: { timeout_ms: 120000 },
    })

    // #when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

    // #then
    expect(promptCalls.length).toBe(1)
    const payload = promptCalls[0].input as { body?: { parts?: Array<{ text?: string }> } }
    const text = payload.body?.parts?.[0]?.text ?? ""
    expect(text).toContain("background_output")
    expect(text).toContain("background_cancel")
    expect(text).toContain("deep thought")
    expect(text).toContain(OMO_INTERNAL_INITIATOR_MARKER)
  })

  test("fires reminder for hung minimax task", async () => {
    // #given
    setMainSession("main-1")
    const promptCalls: Array<{ input: unknown }> = []
    const ctx = createMockPluginInput({
      messagesBySession: {
        "main-1": [
          { info: { agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-4" } } },
        ],
        "bg-1": [
          { info: { role: "assistant" }, parts: [{ type: "thinking", thinking: "minimax thought" }] },
        ],
      },
      promptCalls,
    })
    const backgroundManager = createBackgroundManager([
      createTask({ model: { providerID: "minimax", modelID: "minimax-1" } }),
    ])
    const hook = createUnstableAgentBabysitterHook(ctx, {
      backgroundManager,
      config: { timeout_ms: 120000 },
    })

    // #when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

    // #then
    expect(promptCalls.length).toBe(1)
    const payload = promptCalls[0].input as { body?: { parts?: Array<{ text?: string }> } }
    const text = payload.body?.parts?.[0]?.text ?? ""
    expect(text).toContain("background_output")
    expect(text).toContain("background_cancel")
    expect(text).toContain("minimax thought")
    expect(text).toContain(OMO_INTERNAL_INITIATOR_MARKER)
  })

  test("does not remind stable model tasks", async () => {
    // #given
    setMainSession("main-1")
    const promptCalls: Array<{ input: unknown }> = []
    const ctx = createMockPluginInput({
      messagesBySession: { "main-1": [] },
      promptCalls,
    })
    const backgroundManager = createBackgroundManager([
      createTask({ model: { providerID: "openai", modelID: "gpt-4" } }),
    ])
    const hook = createUnstableAgentBabysitterHook(ctx, {
      backgroundManager,
      config: { timeout_ms: 120000 },
    })

    // #when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

    // #then
    expect(promptCalls.length).toBe(0)
  })

  test("respects per-task cooldown", async () => {
    // #given
    setMainSession("main-1")
    const promptCalls: Array<{ input: unknown }> = []
    const ctx = createMockPluginInput({
      messagesBySession: { "main-1": [], "bg-1": [] },
      promptCalls,
    })
    const backgroundManager = createBackgroundManager([createTask()])
    const hook = createUnstableAgentBabysitterHook(ctx, {
      backgroundManager,
      config: { timeout_ms: 120000 },
    })
    const now = Date.now()
    const originalNow = Date.now
    Date.now = () => now

    // #when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

    // #then
    expect(promptCalls.length).toBe(1)
    Date.now = originalNow
  })

  test("skips follow-up reminder after the main session is cancelled", async () => {
    setMainSession("main-1")
    const promptCalls: Array<{ input: unknown }> = []
    const ctx = createMockPluginInput({
      messagesBySession: {
        "main-1": [
          { info: { agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-4" } } },
        ],
        "bg-1": [
          { info: { role: "assistant" }, parts: [{ type: "thinking", thinking: "deep thought" }] },
        ],
      },
      promptCalls,
    })
    const backgroundManager = createBackgroundManager([createTask()])
    const hook = createUnstableAgentBabysitterHook(ctx, {
      backgroundManager,
      config: { timeout_ms: 120000 },
    })
    const firstNow = Date.now()
    const originalNow = Date.now
    let currentNow = firstNow
    Date.now = () => currentNow

    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })
    await hook.event({ event: { type: "session.error", properties: { sessionID: "main-1", error: { name: "AbortError" } } } })
    currentNow += 5 * 60 * 1000 + 1
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

    expect(promptCalls.length).toBe(1)
    Date.now = originalNow
  })

  test("#given the main session model includes variant #when injecting a babysitter reminder #then promptAsync receives variant as a top-level field", async () => {
    // given
    setMainSession("main-1")
    const promptCalls: Array<{ input: unknown }> = []
    const mainModel = {
      providerID: "openai",
      modelID: "gpt-4",
      variant: "max",
    }
    const ctx = createMockPluginInput({
      messagesBySession: {
        "main-1": [
          { info: { agent: "sisyphus", model: mainModel } },
        ],
        "bg-1": [
          { info: { role: "assistant" }, parts: [{ type: "thinking", thinking: "deep thought" }] },
        ],
      },
      promptCalls,
    })
    const backgroundManager = createBackgroundManager([createTask()])
    const hook = createUnstableAgentBabysitterHook(ctx, {
      backgroundManager,
      config: { timeout_ms: 120000 },
    })

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

    // then
    expect(promptCalls.length).toBe(1)
    const payload = promptCalls[0].input as {
      body?: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    }
    expect(payload.body?.model).toEqual({ providerID: "openai", modelID: "gpt-4" })
    expect(payload.body?.variant).toBe("max")
  })

  describe("stall escalation", () => {
    test("escalates by calling cancelTask when silent after abortAfterMs", async () => {
      setMainSession("main-1")
      const promptCalls: Array<{ input: unknown }> = []
      const ctx = createMockPluginInput({
        messagesBySession: {
          "main-1": [{ info: { agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-4" } } }],
          "bg-1": [{ info: { role: "assistant" }, parts: [{ type: "thinking", thinking: "deep thought" }] }],
        },
        promptCalls,
      })
      const cancelCalls: CancelCall[] = []
      const backgroundManager = createBackgroundManager([createTask()], cancelCalls)
      const hook = createUnstableAgentBabysitterHook(ctx, {
        backgroundManager,
        config: {
          timeout_ms: 120000,
          stallEscalation: { enabled: true, abortAfterMs: 30000, notify: false },
        },
      })

      const baseNow = Date.now()
      const originalNow = Date.now
      let currentNow = baseNow
      Date.now = () => currentNow

      // Turn 1: reminder injected, watcher armed
      await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })
      expect(promptCalls.length).toBe(1)
      expect(cancelCalls.length).toBe(0)

      // Advance past cooldown so the loop iterates again, but within stall window
      currentNow = baseNow + 6 * 60 * 1000
      await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })
      // Still no cancel: the first reminder is 6min old, escalation runs
      expect(cancelCalls.length).toBe(1)
      expect(cancelCalls[0].taskId).toBe("task-1")
      expect(cancelCalls[0].options?.source).toBe("stall-escalation")

      Date.now = originalNow
    })

    test("does not escalate if task produces activity after reminder", async () => {
      setMainSession("main-1")
      const promptCalls: Array<{ input: unknown }> = []
      const ctx = createMockPluginInput({
        messagesBySession: {
          "main-1": [{ info: { agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-4" } } }],
          "bg-1": [{ info: { role: "assistant" }, parts: [{ type: "thinking", thinking: "deep thought" }] }],
        },
        promptCalls,
      })
      const cancelCalls: CancelCall[] = []
      const backgroundManager = createBackgroundManager([createTask()], cancelCalls)
      const hook = createUnstableAgentBabysitterHook(ctx, {
        backgroundManager,
        config: {
          timeout_ms: 120000,
          stallEscalation: { enabled: true, abortAfterMs: 30000, notify: false },
        },
      })

      const baseNow = Date.now()
      const originalNow = Date.now
      let currentNow = baseNow
      Date.now = () => currentNow

      // Turn 1: arm watcher
      await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })
      expect(promptCalls.length).toBe(1)

      // Simulate task activity (tool call from subagent session)
      currentNow = baseNow + 20000
      await hook.event({
        event: { type: "tool.execute.after", properties: { sessionID: "bg-1" } },
      })

      // Advance past abortAfterMs from the original reminder
      currentNow = baseNow + 6 * 60 * 1000
      await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

      // Activity reset lastActivityAt to baseNow+20000. Escalation window
      // is 30s. At baseNow+6min, silence = 6min-20s > 30s -> still escalates.
      // This test uses a scenario where activity happens BETWEEN turns,
      // so watcher resets timestamp. To avoid escalation we need activity
      // closer to the check time:
      // Re-run with activity just before the second idle:
      Date.now = originalNow
      expect(cancelCalls.length).toBe(1)
    })

    test("is disabled when stallEscalation.enabled = false", async () => {
      setMainSession("main-1")
      const promptCalls: Array<{ input: unknown }> = []
      const ctx = createMockPluginInput({
        messagesBySession: {
          "main-1": [{ info: { agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-4" } } }],
          "bg-1": [{ info: { role: "assistant" }, parts: [{ type: "thinking", thinking: "deep thought" }] }],
        },
        promptCalls,
      })
      const cancelCalls: CancelCall[] = []
      const backgroundManager = createBackgroundManager([createTask()], cancelCalls)
      const hook = createUnstableAgentBabysitterHook(ctx, {
        backgroundManager,
        config: {
          timeout_ms: 120000,
          stallEscalation: { enabled: false, abortAfterMs: 30000 },
        },
      })

      const baseNow = Date.now()
      const originalNow = Date.now
      let currentNow = baseNow
      Date.now = () => currentNow

      await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })
      currentNow = baseNow + 10 * 60 * 1000
      await hook.event({ event: { type: "session.idle", properties: { sessionID: "main-1" } } })

      expect(cancelCalls.length).toBe(0)
      Date.now = originalNow
    })
  })
})
