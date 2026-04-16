import type { PluginInput } from "@opencode-ai/plugin"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import { log } from "../../shared/logger"

/**
 * Post-Implementation Review — when Hephaestus (or any configured
 * implementer subagent) completes a task via the `task` tool, this hook
 * automatically invokes Momus in the parent session to review the work
 * against the plan. Loops back to Hephaestus via session_id if Momus
 * rejects.
 *
 * Triggered by `tool.execute.after` events on the `task` tool whose
 * `subagent_type` matches one of `reviewableAgents` (default:
 * ["hephaestus"]). The Momus invocation is injected into the same
 * session that spawned the implementer, so Sisyphus sees it as a natural
 * follow-up turn.
 *
 * This hook does NOT fire for trivial work: it checks output length and
 * skips if the implementer's response looks like a light edit or a
 * no-op. For the heavy path (multi-file changes, schema edits, new
 * features), the review is mandatory.
 */

const HOOK_NAME = "post-implementation-review"

/** Default agents whose completion triggers Momus review. */
const DEFAULT_REVIEWABLE_AGENTS = ["hephaestus"]

/**
 * Minimum output length to consider the task substantial enough to
 * merit Momus review. Shorter responses are typically acknowledgements
 * or trivial edits that don't need the ~30-60s overhead of a review.
 */
const DEFAULT_MIN_OUTPUT_CHARS = 400

/**
 * Per-session cooldown to avoid firing multiple reviews when Sisyphus
 * chains several Hephaestus tasks rapidly. 60s is enough to skip rapid
 * retries but allow legitimate sequential delegations after an interval.
 */
const DEFAULT_COOLDOWN_MS = 60_000

export interface PostImplementationReviewConfig {
  enabled?: boolean
  /** Subagent types whose completion triggers Momus review. */
  reviewableAgents?: string[]
  /** Minimum output length (chars) to trigger review. */
  minOutputChars?: number
  /** Cooldown between reviews per session (ms). */
  cooldownMs?: number
}

export interface PostImplementationReviewContext {
  directory: string
  client: PluginInput["client"]
}

export interface PostImplementationReviewOptions {
  ctx: PostImplementationReviewContext
  config?: PostImplementationReviewConfig
}

interface ToolInput {
  sessionID: string
  callID: string
  tool: string
  args?: Record<string, unknown>
}

interface ToolOutput {
  output?: unknown
  metadata?: Record<string, unknown>
}

function extractSubagentType(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null
  const value = args["subagent_type"]
  return typeof value === "string" ? value : null
}

function extractPrompt(args: Record<string, unknown> | undefined): string {
  if (!args) return ""
  const value = args["prompt"]
  return typeof value === "string" ? value : ""
}

function extractSessionIDFromOutput(output: unknown): string | null {
  if (typeof output !== "string") return null
  // delegate-task returns a structured result that includes session_id
  // as `session_id=` or `"session_id":"..."` inside the text output.
  const match =
    output.match(/session_id\s*[=:]\s*["]?([a-zA-Z0-9_-]+)/) ??
    output.match(/"session_id"\s*:\s*"([^"]+)"/)
  return match ? match[1] : null
}

function outputLength(output: unknown): number {
  if (typeof output === "string") return output.length
  if (output === null || output === undefined) return 0
  try {
    return JSON.stringify(output).length
  } catch {
    return 0
  }
}

function buildMomusInjection(args: {
  implementerAgent: string
  implementerSessionID: string | null
  originalPrompt: string
}): string {
  const { implementerAgent, implementerSessionID, originalPrompt } = args
  const trimmedPrompt = originalPrompt.trim().slice(0, 2000)
  const sessionLine = implementerSessionID
    ? `Implementer session ID: ${implementerSessionID} (use it to feed Momus back via session_id if rejected).`
    : "Implementer session ID unavailable — Momus should review based on the observed diff."
  return [
    "<post_implementation_review>",
    `${implementerAgent} just completed an implementation task. A post-implementation review is mandatory.`,
    "",
    "MANDATORY next step:",
    `1. Invoke Momus: task(subagent_type="momus", prompt="Review ${implementerAgent}'s implementation for plan adherence, missed MUST-DOs, scope creep, and reversibility risks. ${sessionLine} Original request: ${trimmedPrompt}")`,
    "2. If Momus returns OKAY: run lint/typecheck/tests and mark task done.",
    `3. If Momus rejects: re-invoke ${implementerAgent} via session_id="${implementerSessionID ?? "<session_id>"}" with Momus's feedback as the prompt. Loop until OKAY.`,
    "",
    "Do NOT mark the task done until Momus returns OKAY.",
    "</post_implementation_review>",
  ].join("\n")
}

export function createPostImplementationReviewHook(options: PostImplementationReviewOptions) {
  const config = options.config ?? {}
  if (config.enabled === false) {
    return { "tool.execute.after": async () => {} }
  }

  const reviewableAgents = new Set(config.reviewableAgents ?? DEFAULT_REVIEWABLE_AGENTS)
  const minOutputChars = config.minOutputChars ?? DEFAULT_MIN_OUTPUT_CHARS
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS

  const lastReviewAt = new Map<string, number>()

  const injectReview = async (
    sessionID: string,
    injection: string
  ): Promise<void> => {
    const body = {
      parts: [createInternalAgentTextPart(injection)],
    }
    const session = options.ctx.client.session as unknown as {
      promptAsync?: (args: {
        path: { id: string }
        body: typeof body
        query?: { directory?: string }
      }) => Promise<unknown>
      prompt?: (args: {
        path: { id: string }
        body: typeof body
        query?: { directory?: string }
      }) => Promise<unknown>
    }
    const invoke = session.promptAsync ?? session.prompt
    if (!invoke) {
      log(`[${HOOK_NAME}] neither promptAsync nor prompt available`, { sessionID })
      return
    }
    await invoke({
      path: { id: sessionID },
      body,
      query: { directory: options.ctx.directory },
    })
  }

  const toolExecuteAfter = async (input: ToolInput, output: ToolOutput): Promise<void> => {
    if (input.tool !== "task") return

    const subagent = extractSubagentType(input.args)
    if (!subagent) return
    if (!reviewableAgents.has(subagent)) return

    const length = outputLength(output.output)
    if (length < minOutputChars) {
      log(`[${HOOK_NAME}] skipped: output ${length} < minOutputChars ${minOutputChars}`, {
        sessionID: input.sessionID,
        subagent,
      })
      return
    }

    const now = Date.now()
    const last = lastReviewAt.get(input.sessionID)
    if (last !== undefined && now - last < cooldownMs) {
      log(`[${HOOK_NAME}] skipped: session in cooldown`, {
        sessionID: input.sessionID,
        since: now - last,
        cooldownMs,
      })
      return
    }

    const implementerSessionID = extractSessionIDFromOutput(output.output)
    const originalPrompt = extractPrompt(input.args)
    const injection = buildMomusInjection({
      implementerAgent: subagent,
      implementerSessionID,
      originalPrompt,
    })

    try {
      await injectReview(input.sessionID, injection)
      lastReviewAt.set(input.sessionID, now)
      log(`[${HOOK_NAME}] Momus review dispatched`, {
        sessionID: input.sessionID,
        subagent,
        implementerSessionID,
        outputLength: length,
      })
    } catch (error) {
      log(`[${HOOK_NAME}] injection failed`, {
        sessionID: input.sessionID,
        error: String(error),
      })
    }
  }

  // Also clear state on session end.
  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    if (event.type !== "session.deleted" && event.type !== "session.compacted") return
    const props = event.properties as { sessionID?: string; info?: { id?: string } } | undefined
    const sessionID = props?.sessionID ?? props?.info?.id
    if (sessionID) lastReviewAt.delete(sessionID)
  }

  return {
    "tool.execute.after": toolExecuteAfter,
    event: eventHandler,
  }
}
