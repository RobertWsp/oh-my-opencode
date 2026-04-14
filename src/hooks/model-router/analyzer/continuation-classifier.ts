import { log } from "../../../shared/logger"
import { readClaudeOAuthCredentials } from "./credentials"
import { renderContextForPrompt, type ContextSnapshot } from "./context-builder"

/**
 * Context-aware continuation classifier (multi-intent version).
 *
 * When a prompt arrives mid-session, the classifier decides one of seven
 * intents. Each intent has a specific routing policy:
 *
 *   - continuation          → preserve current tier (e.g. "continuar", "sim")
 *   - correction            → preserve current tier ("não, faz assim")
 *   - clarification         → preserve current tier ("o que você quis dizer?")
 *   - interruption          → preserve current tier, do NOT count as new turn
 *                              ("pare", "espera", "cancela")
 *   - expansion_same_scope  → preserve current tier ("ok, agora faz Y também"
 *                              onde Y é trivial dentro do mesmo contexto)
 *   - expansion_new_scope   → re-analyze with analyzer (scope grew,
 *                              complexity may have changed)
 *   - new_task              → re-analyze from scratch (clearly new topic)
 *
 * Design principles:
 *   - Heavy/saturated context + non-cwd-change = preserve (hard rule)
 *   - Turn 1 = new_task (never a continuation)
 *   - Very short prompt (< 25 chars) without strong topic shift = continuation
 *   - Everything else: Haiku classifies with full session context
 */

export type ContinuationIntent =
  | "continuation"
  | "correction"
  | "clarification"
  | "interruption"
  | "expansion_same_scope"
  | "expansion_new_scope"
  | "new_task"

/**
 * Policy per intent:
 *   - "preserve":  keep current model (no analyzer, no re-routing)
 *   - "reanalyze": dispatch to analyzer → full decision matrix
 */
export function intentPolicy(intent: ContinuationIntent): "preserve" | "reanalyze" {
  switch (intent) {
    case "continuation":
    case "correction":
    case "clarification":
    case "interruption":
    case "expansion_same_scope":
      return "preserve"
    case "expansion_new_scope":
    case "new_task":
      return "reanalyze"
  }
}

/**
 * Whether an interruption intent means we should NOT increment turn
 * count or persist a new decision — the user is aborting, not advancing.
 */
export function isInterruption(intent: ContinuationIntent): boolean {
  return intent === "interruption"
}

export interface ClassifierInput {
  promptText: string
  /** Current model tier (haiku/sonnet/opus/opus-plan or unknown). */
  currentTier: string | undefined
  /** Context load: fresh | normal | heavy | saturated */
  contextLoad: "fresh" | "normal" | "heavy" | "saturated"
  /** Total input tokens in the session so far. */
  totalInputTokens: number
  /** Turn number in this session (1 = first). */
  turnNumber: number
  /** Optional rich context snapshot (recent messages, cwd, topic shift). */
  contextSnapshot?: ContextSnapshot
}

export interface ClassifierResult {
  intent: ContinuationIntent
  reason: string
  durationMs: number
  llmUsed: boolean
  error?: string
}

const CLASSIFIER_TIMEOUT_MS = 4_000

function buildPrompt(input: ClassifierInput): string {
  const lines: string[] = []

  lines.push(`You are a micro-classifier for a Claude coding agent's model router.

Given the session context and the user's new message, classify the user's INTENT into
EXACTLY ONE of these 7 categories:

  1. continuation        — user confirms, proceeds, or explicitly continues the same work
                           ("continuar", "sim", "ok, prossiga", "certo faz isso")
  2. correction          — user corrects the direction but keeps the same task
                           ("não, não é assim", "na verdade faz X em vez de Y", "corrige isso")
  3. clarification       — user asks a question about what the assistant just said
                           ("o que você quis dizer com X?", "por que essa abordagem?")
  4. interruption        — user wants to stop or abort the current action
                           ("pare", "espera", "cancela", "stop", "não faz isso agora")
  5. expansion_same_scope — user asks for MORE work within the same small scope
                            ("adiciona também Y", "faz isso com mais um campo")
                            Use when Y is trivial and obviously part of the same task.
  6. expansion_new_scope — user adds NEW work that significantly changes scope
                           ("ok, agora adiciona um dashboard com websockets",
                            "agora faz isso para todos os endpoints")
                           Use when the new scope may warrant a DIFFERENT model tier.
  7. new_task            — user starts a substantially different task
                           ("agora vamos fazer X", "esquece, preciso implementar Y",
                            "certo, agora faz uma análise de segurança")

CRITICAL RULE 1 — Heavy context bias:
If context_load is "heavy" or "saturated" (>100k tokens in context), LEAN toward
continuation/correction/clarification/expansion_same_scope. Switching models mid-heavy-context
breaks compaction and loses context awareness. Only choose expansion_new_scope or new_task if
the user is UNAMBIGUOUSLY starting unrelated work.

CRITICAL RULE 2 — Continuation over length:
A long reply can still be a pure continuation. If the user is responding to something the
assistant just asked (e.g. the assistant offered options and the user picked one with
justification), that's continuation even if the reply is 500 chars.

CRITICAL RULE 3 — New task despite polite opener:
Prompts starting with "certo", "ok", "perfeito" can still be new_task if the rest of the
prompt describes unrelated work. Don't be fooled by the opener — read the whole prompt.

CRITICAL RULE 4 — Interruption detection:
Short imperatives like "pare", "para", "espera", "cancela", "stop", "hold on", "wait" WITHOUT
additional new-task content = interruption. If the user says "pare, faz X em vez disso" that's
correction, not interruption.

CRITICAL RULE 5 — Correction vs new task:
"não, faz assim" about the CURRENT work → correction (preserve model).
"não, agora quero fazer algo totalmente diferente" → new_task (re-analyze).`)

  lines.push("")
  lines.push("<session_state>")
  lines.push(`current_tier: ${input.currentTier ?? "unknown"}`)
  lines.push(`context_load: ${input.contextLoad}`)
  lines.push(`total_input_tokens: ${input.totalInputTokens}`)
  lines.push(`turn_number: ${input.turnNumber}`)
  lines.push("</session_state>")

  if (input.contextSnapshot) {
    lines.push("")
    lines.push(renderContextForPrompt(input.contextSnapshot))
  }

  lines.push("")
  lines.push("<user_message>")
  lines.push(input.promptText)
  lines.push("</user_message>")
  lines.push("")
  lines.push(
    "Reply with EXACTLY ONE WORD (no punctuation, no explanation) from this list:",
  )
  lines.push(
    "continuation | correction | clarification | interruption | expansion_same_scope | expansion_new_scope | new_task",
  )

  return lines.join("\n")
}

const VALID_INTENTS: readonly ContinuationIntent[] = [
  "continuation",
  "correction",
  "clarification",
  "interruption",
  "expansion_same_scope",
  "expansion_new_scope",
  "new_task",
]

/**
 * Parse a Haiku response into a ContinuationIntent. Accepts the exact
 * word; falls back to "new_task" on garbage (safer to re-analyze than
 * to blindly preserve when Haiku is confused).
 */
function parseIntent(text: string): ContinuationIntent | null {
  const normalized = text.trim().toLowerCase().replace(/[^a-z_]/g, "")
  for (const intent of VALID_INTENTS) {
    if (normalized === intent || normalized.startsWith(intent)) return intent
  }
  // Backwards-compat: accept legacy "preserve" / "reanalyze" words
  if (normalized === "preserve") return "continuation"
  if (normalized === "reanalyze" || normalized === "reanalyse") return "new_task"
  return null
}

export async function classifyContinuation(input: ClassifierInput): Promise<ClassifierResult> {
  const started = Date.now()

  // ─── Hard rule 1: Heavy/saturated context + no cwd change = continuation ─
  // Switching models mid-heavy-context breaks compaction and loses context
  // awareness. The ONLY exception is when cwd changed (literally a different
  // codebase — previous context doesn't apply).
  if (input.contextLoad === "heavy" || input.contextLoad === "saturated") {
    const cwdChanged = input.contextSnapshot?.cwdChanged ?? false
    if (!cwdChanged) {
      return {
        intent: "continuation",
        reason: `hard_rule:heavy_context(${input.contextLoad}:${input.totalInputTokens}tok)`,
        durationMs: Date.now() - started,
        llmUsed: false,
      }
    }
    // cwd changed despite heavy context — fall through to LLM to decide
  }

  // ─── Hard rule 2: Turn 1 is always new_task ──────────────────────────
  if (input.turnNumber <= 1) {
    return {
      intent: "new_task",
      reason: "hard_rule:first_turn",
      durationMs: Date.now() - started,
      llmUsed: false,
    }
  }

  // ─── Soft rule: Very short prompt = continuation ─────────────────────
  // "sim", "ok", "continuar", "prossiga", single-word acknowledgments.
  if (input.promptText.trim().length < 25) {
    return {
      intent: "continuation",
      reason: "heuristic:very_short_prompt",
      durationMs: Date.now() - started,
      llmUsed: false,
    }
  }

  // ─── LLM classification for everything else ──────────────────────────
  const classifyResult = await callClassifierLLM(input)
  return {
    ...classifyResult,
    durationMs: Date.now() - started,
  }
}

/**
 * Invoke Haiku for intent classification. Tries Meridian proxy first
 * (if ANTHROPIC_BASE_URL set), falls back to direct OAuth on Meridian
 * 429 or missing proxy. Returns continuation on hard failure (safer
 * default — preserves current tier).
 */
async function callClassifierLLM(
  input: ClassifierInput,
): Promise<Omit<ClassifierResult, "durationMs">> {
  const prompt = buildPrompt(input)

  // Attempt 1: Meridian proxy (avoids burning a single account's rate limits)
  const meridianBaseUrl = process.env.ANTHROPIC_BASE_URL
  const meridianApiKey = process.env.ANTHROPIC_API_KEY
  if (meridianBaseUrl && meridianApiKey) {
    const result = await httpClassifierCall({
      endpoint: `${meridianBaseUrl.replace(/\/$/, "")}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": meridianApiKey,
        "anthropic-version": "2023-06-01",
      },
      prompt,
      systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude.",
    })
    if (result.ok || !result.error?.startsWith("HTTP 429")) return result
    // else fall through to direct OAuth
  }

  // Attempt 2: Direct api.anthropic.com via OAuth
  const creds = await readClaudeOAuthCredentials()
  if (!creds) {
    return {
      intent: "continuation",
      reason: "fallback:no_transport",
      llmUsed: false,
      error: "no_credentials_and_no_proxy",
    }
  }
  return httpClassifierCall({
    endpoint: "https://api.anthropic.com/v1/messages",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.107 (external, cli)",
    },
    prompt,
    systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude.",
  })
}

/**
 * Single HTTP call to the classifier endpoint. Returns classifier result
 * with ok flag so caller can decide to retry on the alternate transport.
 */
async function httpClassifierCall(args: {
  endpoint: string
  headers: Record<string, string>
  prompt: string
  systemPrompt: string
}): Promise<Omit<ClassifierResult, "durationMs"> & { ok: boolean }> {
  const { endpoint, headers, prompt, systemPrompt } = args
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS)

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      return {
        ok: false,
        intent: "continuation", // safe default
        reason: `fallback:http_${response.status}`,
        llmUsed: true,
        error: `HTTP ${response.status}: ${errorText.slice(0, 100)}`,
      }
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    // Haiku may emit a `thinking` block before `text` when extended
    // thinking is on — find the first text block explicitly.
    const rawText =
      payload.content?.find((b) => b.type === "text" && typeof b.text === "string")?.text ?? ""
    const parsed = parseIntent(rawText)

    if (!parsed) {
      // Haiku returned something unparseable. Safer to preserve than to
      // risk wrong re-analysis when we can't trust the classifier output.
      log("[continuation-classifier] unparseable intent, defaulting to continuation", {
        raw: rawText.slice(0, 50),
      })
      return {
        ok: true,
        intent: "continuation",
        reason: `llm:unparsed(${rawText.slice(0, 30)})`,
        llmUsed: true,
      }
    }

    return {
      ok: true,
      intent: parsed,
      reason: `llm:${parsed}`,
      llmUsed: true,
    }
  } catch (e) {
    clearTimeout(timer)
    const err = e as Error
    return {
      ok: false,
      intent: "continuation", // safe default on timeout/network error
      reason: err.name === "AbortError" ? "fallback:timeout" : "fallback:network_error",
      llmUsed: true,
      error: err.name === "AbortError" ? "timeout" : err.message,
    }
  }
}
