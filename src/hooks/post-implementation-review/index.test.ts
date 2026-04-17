import { describe, expect, test, beforeEach } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createPostImplementationReviewHook } from "./index"

/**
 * Unit tests for post-implementation-review.
 *
 * Covers:
 * - Triggers on task(subagent_type=hephaestus) with substantial output
 * - Skips on tool != "task"
 * - Skips on unlisted subagent types
 * - Skips on short output
 * - Respects cooldown per session
 * - Respects enabled=false
 * - Clears cooldown state on session end
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
  return {
    directory: "/tmp/test",
    client: { session } as unknown as PluginInput["client"],
  }
}

type ToolInput = { sessionID: string; callID: string; tool: string; args?: Record<string, unknown> }
type ToolOutput = { output?: unknown; metadata?: Record<string, unknown> }

describe("post-implementation-review", () => {
  let promptCalls: Array<{ sessionID: string; text: string }>

  beforeEach(() => {
    promptCalls = []
  })

  test("triggers when task(subagent=hephaestus) completes with substantial output", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx })

    const input: ToolInput = {
      sessionID: "ses_1",
      callID: "call_1",
      tool: "task",
      args: {
        subagent_type: "hephaestus",
        prompt: "Implement feature X",
      },
    }
    const output: ToolOutput = {
      output: "Done. Changes in src/x.ts and test/x.test.ts. session_id=ses_sub_1. " + "x".repeat(500),
    }

    await hook["tool.execute.after"]!(input, output)

    expect(promptCalls.length).toBe(1)
    expect(promptCalls[0].sessionID).toBe("ses_1")
    expect(promptCalls[0].text).toContain("<post_implementation_review>")
    expect(promptCalls[0].text).toContain("ses_sub_1")
    expect(promptCalls[0].text).toContain('subagent_type="momus"')
  })

  test("skips when tool is not task", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx })

    await hook["tool.execute.after"]!(
      {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "edit",
        args: { subagent_type: "hephaestus" },
      },
      { output: "x".repeat(1000) },
    )
    expect(promptCalls.length).toBe(0)
  })

  test("skips when subagent is not in reviewableAgents", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx })

    await hook["tool.execute.after"]!(
      {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "task",
        args: { subagent_type: "explore", prompt: "Find X" },
      },
      { output: "x".repeat(1000) },
    )
    expect(promptCalls.length).toBe(0)
  })

  test("skips when output is below minOutputChars", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx, config: { minOutputChars: 100 } })

    await hook["tool.execute.after"]!(
      {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "task",
        args: { subagent_type: "hephaestus", prompt: "x" },
      },
      { output: "tiny response" },
    )
    expect(promptCalls.length).toBe(0)
  })

  test("respects cooldown within same session", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx, config: { cooldownMs: 60_000 } })

    const makeInvocation = (call: string) => ({
      input: {
        sessionID: "ses_1",
        callID: call,
        tool: "task",
        args: { subagent_type: "hephaestus", prompt: "x" },
      },
      output: { output: "x".repeat(500) },
    })

    const a = makeInvocation("call_1")
    const b = makeInvocation("call_2")

    await hook["tool.execute.after"]!(a.input, a.output)
    await hook["tool.execute.after"]!(b.input, b.output)

    expect(promptCalls.length).toBe(1)
  })

  test("different sessions do not share cooldown", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx, config: { cooldownMs: 60_000 } })

    const make = (sid: string) => ({
      input: {
        sessionID: sid,
        callID: "c",
        tool: "task",
        args: { subagent_type: "hephaestus", prompt: "x" },
      },
      output: { output: "x".repeat(500) },
    })

    const a = make("ses_1")
    const b = make("ses_2")

    await hook["tool.execute.after"]!(a.input, a.output)
    await hook["tool.execute.after"]!(b.input, b.output)

    expect(promptCalls.length).toBe(2)
  })

  test("honours enabled=false", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx, config: { enabled: false } })

    await hook["tool.execute.after"]!(
      {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "task",
        args: { subagent_type: "hephaestus", prompt: "x" },
      },
      { output: "x".repeat(500) },
    )
    expect(promptCalls.length).toBe(0)
  })

  test("custom reviewableAgents triggers for atlas", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({
      ctx,
      config: { reviewableAgents: ["atlas"] },
    })

    await hook["tool.execute.after"]!(
      {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "task",
        args: { subagent_type: "atlas", prompt: "Run plan" },
      },
      { output: "x".repeat(500) },
    )
    expect(promptCalls.length).toBe(1)
  })

  test("clears session cooldown on session.deleted", async () => {
    const ctx = makeCtx(promptCalls)
    const hook = createPostImplementationReviewHook({ ctx, config: { cooldownMs: 60_000 } })

    await hook["tool.execute.after"]!(
      {
        sessionID: "ses_1",
        callID: "c",
        tool: "task",
        args: { subagent_type: "hephaestus", prompt: "x" },
      },
      { output: "x".repeat(500) },
    )
    expect(promptCalls.length).toBe(1)

    // Emit session.deleted to clear cooldown
    await hook.event!({
      event: { type: "session.deleted", properties: { info: { id: "ses_1" } } },
    })

    await hook["tool.execute.after"]!(
      {
        sessionID: "ses_1",
        callID: "c2",
        tool: "task",
        args: { subagent_type: "hephaestus", prompt: "x" },
      },
      { output: "x".repeat(500) },
    )
    expect(promptCalls.length).toBe(2)
  })
})
