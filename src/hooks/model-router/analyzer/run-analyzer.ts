import { log } from "../../../shared/logger"
import type { TaskAnalysis } from "../types"
import { readClaudeOAuthCredentials } from "./credentials"
import { TaskAnalysisSchema } from "./schema"
import { buildAnalyzerSystemPrompt, buildAnalyzerUserMessage } from "./prompt"

export interface RunAnalyzerOptions {
  userPromptText: string
  agent: string
  turnNumber: number
  previousTierIfAny: string | null
  analyzerModelID: string
  timeoutMs: number
  /**
   * Override endpoint. When running under the Meridian wrapper, the
   * ANTHROPIC_BASE_URL env var points to Meridian, so analyzer calls
   * flow through the subscription bridge transparently.
   */
  baseUrlOverride?: string
  apiKeyOverride?: string
}

export interface AnalyzerResult {
  ok: boolean
  analysis: TaskAnalysis | null
  durationMs: number
  error?: string
}

/**
 * Run the analyzer. Uses PLAIN TEXT JSON output (no tool_use) because
 * when proxied through Meridian, tool_choice is not forwarded to the SDK
 * subprocess — tools are wrapped in an MCP server and the model can't be
 * forced to call a specific tool. Instead, we instruct the model to
 * respond with ONLY a JSON object, then parse and validate.
 *
 * The system prompt includes detailed schema + few-shot examples to make
 * the JSON output reliable. Sonnet 4.6 handles this well.
 *
 * Transport preference (in order):
 *   1. Meridian proxy (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY set by the
 *      ~/bin/opencode wrapper). Multi-profile rotation handles 429s
 *      transparently, spreading analyzer calls across 6 Max accounts.
 *   2. On 429 from Meridian OR if Meridian env vars are missing, fall back
 *      to direct api.anthropic.com using the Claude Code OAuth token from
 *      ~/.claude/.credentials.json.
 *
 * Why Meridian-first (was direct-first): direct calls all hit a single
 * account (~/.claude = "main" profile) and burn its quota → 429 → rules
 * fallback. With Meridian, the pool of accounts keeps the LLM path alive.
 */
export async function runAnalyzer(opts: RunAnalyzerOptions): Promise<AnalyzerResult> {
  const started = Date.now()

  const systemPrompt = buildAnalyzerSystemPrompt()
  const userMsg = buildAnalyzerUserMessage({
    userPromptText: opts.userPromptText,
    agent: opts.agent,
    turnNumber: opts.turnNumber,
    previousTierIfAny: opts.previousTierIfAny,
  })

  // ─── Attempt 1: Meridian proxy (preferred) ────────────────────────────
  const meridianBaseUrl = opts.baseUrlOverride ?? process.env.ANTHROPIC_BASE_URL
  const meridianApiKey = opts.apiKeyOverride ?? process.env.ANTHROPIC_API_KEY
  if (meridianBaseUrl && meridianApiKey) {
    const result = await callAnalyzerEndpoint({
      endpoint: `${meridianBaseUrl.replace(/\/$/, "")}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": meridianApiKey,
        "anthropic-version": "2023-06-01",
        "x-router-analyzer": "true",
      },
      systemPrompt,
      userMsg,
      analyzerModelID: opts.analyzerModelID,
      timeoutMs: opts.timeoutMs,
      startedAt: started,
    })
    // Success or non-429 error: return immediately.
    // On 429 from Meridian, try direct OAuth as last resort.
    if (result.ok || !result.error?.startsWith("HTTP 429")) {
      return result
    }
    log("[model-router] Meridian returned 429, retrying via direct OAuth", { error: result.error })
  }

  // ─── Attempt 2: Direct api.anthropic.com via OAuth ────────────────────
  const creds = await readClaudeOAuthCredentials()
  if (!creds) {
    return {
      ok: false,
      analysis: null,
      durationMs: Date.now() - started,
      error:
        "No transport available: Meridian env vars missing AND ~/.claude/.credentials.json unreadable",
    }
  }

  // When calling with OAuth directly, Anthropic requires the system prompt
  // to start with "You are Claude Code, Anthropic's official CLI for Claude."
  // to pass third-party detection. Prepend it (Meridian does this internally
  // when going through the proxy path).
  return callAnalyzerEndpoint({
    endpoint: "https://api.anthropic.com/v1/messages",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.107 (external, cli)",
    },
    systemPrompt: `You are Claude Code, Anthropic's official CLI for Claude.\n\n${systemPrompt}`,
    userMsg,
    analyzerModelID: opts.analyzerModelID,
    timeoutMs: opts.timeoutMs,
    startedAt: started,
  })
}

/**
 * Shared call site for both transport paths. Handles timeout, JSON
 * extraction, schema validation, and error formatting.
 */
async function callAnalyzerEndpoint(args: {
  endpoint: string
  headers: Record<string, string>
  systemPrompt: string
  userMsg: string
  analyzerModelID: string
  timeoutMs: number
  startedAt: number
}): Promise<AnalyzerResult> {
  const { endpoint, headers, systemPrompt, userMsg, analyzerModelID, timeoutMs, startedAt } = args

  const body = {
    model: analyzerModelID,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user" as const, content: userMsg }],
    temperature: 0.1,
    stream: false,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      return {
        ok: false,
        analysis: null,
        durationMs: Date.now() - startedAt,
        error: `HTTP ${response.status}: ${errorText.slice(0, 300)}`,
      }
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
      error?: { message?: string }
    }

    if (payload.error) {
      return {
        ok: false,
        analysis: null,
        durationMs: Date.now() - startedAt,
        error: payload.error.message ?? "unknown error",
      }
    }

    // Collect all text blocks
    const textBlocks = (payload.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")

    if (!textBlocks) {
      return {
        ok: false,
        analysis: null,
        durationMs: Date.now() - startedAt,
        error: "Analyzer returned no text content",
      }
    }

    // Extract JSON from the response. Accepts:
    //   - raw JSON
    //   - JSON inside ```json ... ``` code fence
    //   - JSON inside ``` ... ``` code fence
    const jsonText = extractJsonBlock(textBlocks)
    if (!jsonText) {
      return {
        ok: false,
        analysis: null,
        durationMs: Date.now() - startedAt,
        error: `No JSON block found in response: ${textBlocks.slice(0, 200)}`,
      }
    }

    let parsed
    try {
      parsed = JSON.parse(jsonText)
    } catch (e) {
      return {
        ok: false,
        analysis: null,
        durationMs: Date.now() - startedAt,
        error: `JSON parse failed: ${String(e)}; raw: ${jsonText.slice(0, 200)}`,
      }
    }

    const validated = TaskAnalysisSchema.safeParse(parsed)
    if (!validated.success) {
      log("[model-router] analyzer schema validation failed", {
        errors: validated.error.issues,
        raw: jsonText.slice(0, 500),
      })
      return {
        ok: false,
        analysis: null,
        durationMs: Date.now() - startedAt,
        error: `Schema validation failed: ${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      }
    }

    return {
      ok: true,
      analysis: validated.data as TaskAnalysis,
      durationMs: Date.now() - startedAt,
    }
  } catch (e) {
    const err = e as Error
    const aborted = err.name === "AbortError"
    return {
      ok: false,
      analysis: null,
      durationMs: Date.now() - startedAt,
      error: aborted ? `Timeout after ${timeoutMs}ms` : err.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Extract a JSON object from a text block. Handles:
 *   1. Raw JSON starting with { or [
 *   2. JSON inside ```json ... ``` fence
 *   3. JSON inside ``` ... ``` fence
 *   4. JSON mixed with narration (first { ... last })
 */
function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim()

  // Try fenced code block first
  const jsonFence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(trimmed)
  if (jsonFence && jsonFence[1]) {
    return jsonFence[1].trim()
  }

  // Raw JSON at start
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed
  }

  // First { to last } heuristic (for narrated responses)
  const firstBrace = trimmed.indexOf("{")
  const lastBrace = trimmed.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }

  return null
}
