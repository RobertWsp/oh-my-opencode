import { describe, expect, test, afterEach } from "bun:test"
import {
  classifyContinuation,
  intentPolicy,
  type ClassifierInput,
} from "../analyzer/continuation-classifier"

/**
 * Tests for the context-aware continuation classifier.
 * Covers: hard rules (context load, turn 1), short-circuit heuristics,
 * LLM path (mocked), and fallback behavior.
 */

const originalFetch = globalThis.fetch

function mockHaiku(replyText: string) {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: replyText }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }) as unknown as typeof fetch
}

function mockHaikuError(status: number) {
  globalThis.fetch = (async () => new Response("error", { status })) as unknown as typeof fetch
}

function baseInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    promptText: "continuar",
    currentTier: "opus",
    contextLoad: "normal",
    totalInputTokens: 50_000,
    turnNumber: 5,
    ...overrides,
  }
}

describe("classifyContinuation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ─── Hard rules ─────────────────────────────────────────────────
  test("heavy context + no cwd change → continuation (hard rule)", async () => {
    const r = await classifyContinuation(
      baseInput({
        promptText:
          "continuar, mas agora preciso refatorar completamente a autenticação com JWT",
        contextLoad: "heavy",
        totalInputTokens: 250_000,
      }),
    )
    expect(r.intent).toBe("continuation")
    expect(intentPolicy(r.intent)).toBe("preserve")
    expect(r.reason).toContain("heavy_context")
    expect(r.llmUsed).toBe(false)
  })

  test("saturated context → continuation (preserves model)", async () => {
    const r = await classifyContinuation(
      baseInput({
        promptText: "esquece isso, vamos fazer algo totalmente novo",
        contextLoad: "saturated",
        totalInputTokens: 750_000,
      }),
    )
    expect(r.intent).toBe("continuation")
    expect(intentPolicy(r.intent)).toBe("preserve")
    expect(r.reason).toContain("heavy_context")
  })

  test("turn 1 → new_task (hard rule)", async () => {
    const r = await classifyContinuation(baseInput({ turnNumber: 1 }))
    expect(r.intent).toBe("new_task")
    expect(intentPolicy(r.intent)).toBe("reanalyze")
    expect(r.reason).toContain("first_turn")
    expect(r.llmUsed).toBe(false)
  })

  // ─── Short-circuit heuristics ───────────────────────────────────
  test("very short prompt on fresh context → continuation without LLM", async () => {
    const r = await classifyContinuation(
      baseInput({ promptText: "continuar", contextLoad: "fresh" }),
    )
    expect(r.intent).toBe("continuation")
    expect(intentPolicy(r.intent)).toBe("preserve")
    expect(r.reason).toContain("very_short_prompt")
    expect(r.llmUsed).toBe(false)
  })

  // ─── LLM path (normal context) ──────────────────────────────────
  test("Haiku replies 'continuation' on normal context → preserve policy", async () => {
    mockHaiku("continuation")
    const r = await classifyContinuation(
      baseInput({
        promptText: "certo, faça o merge com a branch dev porfavor quando terminar",
        contextLoad: "normal",
      }),
    )
    expect(r.intent).toBe("continuation")
    expect(intentPolicy(r.intent)).toBe("preserve")
    expect(r.llmUsed).toBe(true)
  })

  test("Haiku replies 'correction' → preserve policy", async () => {
    mockHaiku("correction")
    const r = await classifyContinuation(
      baseInput({ promptText: "não, na verdade faça X em vez de Y" }),
    )
    expect(r.intent).toBe("correction")
    expect(intentPolicy(r.intent)).toBe("preserve")
  })

  test("Haiku replies 'interruption' → preserve policy", async () => {
    mockHaiku("interruption")
    const r = await classifyContinuation(
      baseInput({ promptText: "pare, espera um momento porfavor" }),
    )
    expect(r.intent).toBe("interruption")
    expect(intentPolicy(r.intent)).toBe("preserve")
  })

  test("Haiku replies 'expansion_same_scope' → preserve policy", async () => {
    mockHaiku("expansion_same_scope")
    const r = await classifyContinuation(
      baseInput({ promptText: "ok agora adiciona um campo updated_at também" }),
    )
    expect(r.intent).toBe("expansion_same_scope")
    expect(intentPolicy(r.intent)).toBe("preserve")
  })

  test("Haiku replies 'expansion_new_scope' → reanalyze policy", async () => {
    mockHaiku("expansion_new_scope")
    const r = await classifyContinuation(
      baseInput({
        promptText:
          "ok, o login ficou bom, agora faz um dashboard com métricas em tempo real usando websockets",
      }),
    )
    expect(r.intent).toBe("expansion_new_scope")
    expect(intentPolicy(r.intent)).toBe("reanalyze")
  })

  test("Haiku replies 'new_task' on normal context → reanalyze", async () => {
    mockHaiku("new_task")
    const r = await classifyContinuation(
      baseInput({
        promptText: "agora vamos fazer algo totalmente diferente: implementar CSRF",
        contextLoad: "normal",
      }),
    )
    expect(r.intent).toBe("new_task")
    expect(intentPolicy(r.intent)).toBe("reanalyze")
    expect(r.llmUsed).toBe(true)
  })

  test("Haiku garbage reply → continuation (safer default)", async () => {
    mockHaiku("maybe")
    const r = await classifyContinuation(
      baseInput({
        promptText: "continuar implementando o módulo de testes",
      }),
    )
    expect(r.intent).toBe("continuation")
    expect(intentPolicy(r.intent)).toBe("preserve")
  })

  // ─── Backwards compat: legacy labels from older Haiku responses ──
  test("legacy 'preserve' reply → mapped to continuation", async () => {
    mockHaiku("preserve")
    const r = await classifyContinuation(
      baseInput({ promptText: "certo, faça o commit agora por favor" }),
    )
    expect(r.intent).toBe("continuation")
  })

  test("legacy 'reanalyze' reply → mapped to new_task", async () => {
    mockHaiku("reanalyze")
    const r = await classifyContinuation(
      baseInput({ promptText: "agora implementa algo totalmente diferente" }),
    )
    expect(r.intent).toBe("new_task")
  })

  // ─── Fallback paths ─────────────────────────────────────────────
  test("HTTP 429 fallback → continuation (safer default)", async () => {
    mockHaikuError(429)
    const r = await classifyContinuation(
      baseInput({ promptText: "certo, faça o commit agora por favor" }),
    )
    expect(r.intent).toBe("continuation")
    expect(r.reason).toContain("http_429")
    expect(r.error).toContain("429")
  })

  test("duration always set", async () => {
    mockHaiku("continuation")
    const r = await classifyContinuation(
      baseInput({ promptText: "continuar, faça push para a origin" }),
    )
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })
})
