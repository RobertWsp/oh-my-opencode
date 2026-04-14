import { log } from "../../../shared/logger"
import type { Tier } from "../types"
import { readClaudeOAuthCredentials } from "./credentials"

/**
 * Haiku pre-screen — cheap first pass that decides if we can skip the
 * expensive Sonnet analyzer.
 *
 * Rationale:
 *   - Sonnet analyzer is the correct tool for high-precision classification
 *     but it's expensive (~2-2.5s) and shares rate limits with user's own
 *     Sonnet usage.
 *   - Most prompts are OBVIOUSLY simple (haiku) or OBVIOUSLY standard
 *     (sonnet). Only a minority genuinely need Opus-level reasoning.
 *   - Haiku can identify the obvious cases in ~700ms with very high
 *     confidence. It cannot reliably identify the Opus cases — but we
 *     don't ask it to. It only has two possible outputs:
 *       · "certain_simple"   → classify directly (haiku or sonnet, high conf)
 *       · "needs_sonnet"     → escalate to the Sonnet analyzer
 *
 * This gives us the best of both:
 *   · ~70% of prompts (trivial/standard) resolve with 1 Haiku call
 *   · Complex/ambiguous cases still get full Sonnet reasoning
 *   · Sonnet rate limits are used sparingly
 */

export interface PreScreenInput {
  userPromptText: string
  agent: string
  turnNumber: number
  previousTierIfAny: Tier | null
}

export type PreScreenDecision =
  | { kind: "certain"; tier: "haiku" | "sonnet"; confidence: number; reason: string }
  | { kind: "escalate"; reason: string }
  | { kind: "unavailable"; reason: string }

export interface PreScreenResult {
  decision: PreScreenDecision
  durationMs: number
  llmUsed: boolean
  error?: string
}

/**
 * Pre-screen timeout — generous enough to absorb Meridian cold start
 * (first call ~3-4s) but not so long that it becomes a latency penalty
 * on failure. On timeout we escalate to the full analyzer anyway.
 */
const PRE_SCREEN_TIMEOUT_MS = 6_000

/**
 * Minimum confidence for Haiku's "certain" verdict. Below this, we still
 * escalate to Sonnet. Set conservatively — a wrong pre-screen skips Sonnet
 * entirely and commits to Haiku's judgment.
 */
const MIN_CERTAIN_CONFIDENCE = 0.85

function buildPreScreenPrompt(input: PreScreenInput): string {
  return `You are the fast pre-screen stage of a Claude coding agent's model router.

Your job: look at the user's prompt and decide ONE of two things:

  A) The task is UNAMBIGUOUSLY simple enough that it belongs to "haiku" or "sonnet"
     tier with high confidence — answer with the tier and your confidence.

  B) The task MIGHT need deeper reasoning (opus), OR it's ambiguous, OR you're
     genuinely unsure — answer "escalate" so the heavier Sonnet analyzer takes a
     closer look.

Guidelines for choosing HAIKU (only if ALL are true):
  - trivial edits, single-file changes, simple lookups, greetings
  - the prompt is < 300 chars and has no code blocks
  - risk of doing wrong is minimal (it's reversible, small scope)
  - no architectural concerns

Guidelines for choosing SONNET (if any of these match):
  - typical feature work: add endpoint, write test, implement function
  - 1-3 file changes with a known pattern
  - straightforward refactor within one module
  - standard debugging with a clear failure

Guidelines for ESCALATING (if any of these match):
  - "análise detalhada", "revisão profunda", "auditoria" — explicit deep-thinking asks
  - cross-module, system-wide, or architectural changes
  - debugging production incidents, race conditions, memory leaks
  - security, compliance, data integrity concerns
  - novel or unprecedented problems
  - >500 chars of prompt with specific technical vocabulary
  - "refactor everything", "rewrite", large migrations
  - ambiguous prompts where the scope is unclear

Context about this call:
  agent: ${input.agent}
  turn_number: ${input.turnNumber}
  previous_tier: ${input.previousTierIfAny ?? "none"}

User prompt:
"""
${input.userPromptText}
"""

Respond with EXACTLY ONE LINE in one of these formats:
  haiku <confidence>
  sonnet <confidence>
  escalate <reason-in-3-words>

Where confidence is a number 0.00 to 1.00 (e.g. "haiku 0.92", "sonnet 0.88").
No punctuation, no explanation, no markdown. Just the single line.`
}

export async function runPreScreen(input: PreScreenInput): Promise<PreScreenResult> {
  const started = Date.now()

  const promptText = buildPreScreenPrompt(input)
  const raw = await callPreScreenLLM(promptText)
  if (!raw.ok) {
    return {
      decision: { kind: "unavailable", reason: raw.error ?? "llm_unreachable" },
      durationMs: Date.now() - started,
      llmUsed: raw.llmUsed,
      error: raw.error,
    }
  }

  const decision = parsePreScreenResponse(raw.text)
  log("[haiku-pre-screen] result", {
    raw: raw.text.slice(0, 50),
    decision,
    durationMs: Date.now() - started,
  })

  return {
    decision,
    durationMs: Date.now() - started,
    llmUsed: true,
  }
}

function parsePreScreenResponse(text: string): PreScreenDecision {
  const trimmed = text.trim().toLowerCase()

  // Pattern: "haiku 0.92" / "sonnet 0.87" / "escalate reason"
  const certainMatch = /^(haiku|sonnet)\s+([0-9.]+)/i.exec(trimmed)
  if (certainMatch) {
    const tier = certainMatch[1] as "haiku" | "sonnet"
    const confidence = Math.max(0, Math.min(1, parseFloat(certainMatch[2] ?? "0")))
    if (confidence < MIN_CERTAIN_CONFIDENCE) {
      return {
        kind: "escalate",
        reason: `low_confidence_${tier}(${confidence.toFixed(2)})`,
      }
    }
    return { kind: "certain", tier, confidence, reason: `pre_screen_${tier}` }
  }

  if (trimmed.startsWith("escalate")) {
    const reason = trimmed.replace(/^escalate\s*/, "").slice(0, 30) || "explicit_escalate"
    return { kind: "escalate", reason: `escalate:${reason}` }
  }

  // Unparseable — escalate to be safe
  return { kind: "escalate", reason: `unparsed:${trimmed.slice(0, 20)}` }
}

interface LlmCallResult {
  ok: boolean
  text: string
  llmUsed: boolean
  error?: string
}

async function callPreScreenLLM(prompt: string): Promise<LlmCallResult> {
  // Attempt 1: Meridian proxy
  const meridianBaseUrl = process.env.ANTHROPIC_BASE_URL
  const meridianApiKey = process.env.ANTHROPIC_API_KEY
  if (meridianBaseUrl && meridianApiKey) {
    const result = await httpCall({
      endpoint: `${meridianBaseUrl.replace(/\/$/, "")}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": meridianApiKey,
        "anthropic-version": "2023-06-01",
      },
      prompt,
    })
    if (result.ok || !result.error?.startsWith("HTTP 429")) return result
  }

  // Attempt 2: Direct API via OAuth
  const creds = await readClaudeOAuthCredentials()
  if (!creds) {
    return { ok: false, text: "", llmUsed: false, error: "no_transport" }
  }
  return httpCall({
    endpoint: "https://api.anthropic.com/v1/messages",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.107 (external, cli)",
    },
    prompt,
  })
}

async function httpCall(args: {
  endpoint: string
  headers: Record<string, string>
  prompt: string
}): Promise<LlmCallResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PRE_SCREEN_TIMEOUT_MS)

  try {
    const response = await fetch(args.endpoint, {
      method: "POST",
      headers: args.headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 24,
        temperature: 0,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: args.prompt }],
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      return {
        ok: false,
        text: "",
        llmUsed: true,
        error: `HTTP ${response.status}: ${errorText.slice(0, 80)}`,
      }
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    // Haiku may return `thinking` blocks before the `text` block. Pick
    // the first `text` block specifically — indexing [0] gets `thinking`
    // and returns undefined.text → "".
    const text =
      payload.content?.find((b) => b.type === "text" && typeof b.text === "string")?.text ?? ""
    return { ok: true, text, llmUsed: true }
  } catch (e) {
    clearTimeout(timer)
    const err = e as Error
    return {
      ok: false,
      text: "",
      llmUsed: true,
      error: err.name === "AbortError" ? "timeout" : err.message,
    }
  }
}
