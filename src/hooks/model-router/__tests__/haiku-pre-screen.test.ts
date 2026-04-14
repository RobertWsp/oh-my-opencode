import { describe, expect, test, afterEach } from "bun:test"
import { runPreScreen } from "../analyzer/haiku-pre-screen"

const originalFetch = globalThis.fetch

function mockHaiku(text: string) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch
}

function mockError(status: number) {
  globalThis.fetch = (async () =>
    new Response("err", { status })) as unknown as typeof fetch
}

const baseInput = {
  userPromptText: "fix the typo in README",
  agent: "build",
  turnNumber: 1,
  previousTierIfAny: null,
}

describe("haiku-pre-screen", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("haiku high-confidence verdict → certain haiku", async () => {
    mockHaiku("haiku 0.92")
    const r = await runPreScreen(baseInput)
    expect(r.decision.kind).toBe("certain")
    if (r.decision.kind === "certain") {
      expect(r.decision.tier).toBe("haiku")
      expect(r.decision.confidence).toBeCloseTo(0.92)
    }
  })

  test("sonnet high-confidence verdict → certain sonnet", async () => {
    mockHaiku("sonnet 0.88")
    const r = await runPreScreen(baseInput)
    expect(r.decision.kind).toBe("certain")
    if (r.decision.kind === "certain") {
      expect(r.decision.tier).toBe("sonnet")
    }
  })

  test("low-confidence haiku → escalate (don't commit on guess)", async () => {
    mockHaiku("haiku 0.62")
    const r = await runPreScreen(baseInput)
    expect(r.decision.kind).toBe("escalate")
    if (r.decision.kind === "escalate") {
      expect(r.decision.reason).toContain("low_confidence")
    }
  })

  test("explicit escalate → escalate", async () => {
    mockHaiku("escalate ambiguous_scope")
    const r = await runPreScreen(baseInput)
    expect(r.decision.kind).toBe("escalate")
  })

  test("unparseable → escalate (safer default)", async () => {
    mockHaiku("???")
    const r = await runPreScreen(baseInput)
    expect(r.decision.kind).toBe("escalate")
  })

  test("HTTP 429 → unavailable (let analyzer take over)", async () => {
    mockError(429)
    const r = await runPreScreen(baseInput)
    expect(r.decision.kind).toBe("unavailable")
  })

  test("case-insensitive verdict parsing", async () => {
    mockHaiku("HAIKU 0.95")
    const r = await runPreScreen(baseInput)
    expect(r.decision.kind).toBe("certain")
    if (r.decision.kind === "certain") {
      expect(r.decision.tier).toBe("haiku")
    }
  })

  test("duration always recorded", async () => {
    mockHaiku("sonnet 0.9")
    const r = await runPreScreen(baseInput)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })
})
