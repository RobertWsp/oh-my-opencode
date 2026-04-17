import * as fs from "fs"
import * as path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import { runAnalyzer, type AnalyzerResult } from "../model-router/analyzer/run-analyzer"
import type { TaskAnalysis } from "../model-router/types"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import { log } from "../../shared/logger"

/**
 * Auto-Planning Gate — intercepts the first user message of a session,
 * runs the model-router's Sonnet analyzer to classify the task, and when
 * the task qualifies as complex (architectural / complex_refactor /
 * planning / standard_implementation with high risk), programmatically
 * dispatches the Prometheus planner into the session via `promptAsync`
 * BEFORE the primary agent (Sisyphus) starts normal work.
 *
 * This gate runs the analyzer once per session (keyed by sessionID). If
 * the analyzer classifies the task as something that merits planning, we
 * inject a `task(subagent_type="prometheus", ...)` invocation into the
 * session. The primary agent then sees this as its first instruction
 * and executes the plan → review (Momus) → implementation pipeline.
 *
 * Zero impact on trivial work: trivial_lookup, simple_edit,
 * question_answer, research, debug_investigation, review skip the gate.
 */

const HOOK_NAME = "auto-planning-gate"
const DEFAULT_ANALYZER_MODEL = "claude-sonnet-4-6"
// 45s: accommodates Meridian cold-start + multi-profile rotation under
// rate limit. When analyzer times out the gate fails open (no
// injection), so the only cost of a longer timeout is latency added to
// the first turn of a session when analyzer is genuinely slow.
const DEFAULT_TIMEOUT_MS = 45_000

/** Task types that MUST go through Prometheus before implementation. */
const PLAN_REQUIRED_TASK_TYPES = new Set(["planning", "architectural", "complex_refactor"])

/**
 * Extra gate: a standard_implementation is still plan-worthy when ALL of:
 * - scope_breadth is multi_file or broader (cross_module / system_wide)
 * - reasoning_depth is medium or deeper
 * - risk_level is high or critical OR estimated_files_touched >= 5
 *
 * This catches "implement a feature" that looks routine but spans enough
 * surface to deserve a plan.
 */
function shouldPlanStandardImplementation(analysis: TaskAnalysis): boolean {
  if (analysis.task_type !== "standard_implementation") return false
  const multiFile =
    analysis.scope_breadth === "multi_file_same_module" ||
    analysis.scope_breadth === "cross_module" ||
    analysis.scope_breadth === "system_wide"
  const deepEnough =
    analysis.reasoning_depth === "medium" ||
    analysis.reasoning_depth === "deep" ||
    analysis.reasoning_depth === "exhaustive"
  const risky =
    analysis.risk_level === "high" ||
    analysis.risk_level === "critical" ||
    (analysis.estimated_files_touched ?? 0) >= 5
  return multiFile && deepEnough && risky
}

function meritsPlanning(analysis: TaskAnalysis): { merits: boolean; reason: string } {
  if (PLAN_REQUIRED_TASK_TYPES.has(analysis.task_type)) {
    return { merits: true, reason: `task_type=${analysis.task_type}` }
  }
  if (shouldPlanStandardImplementation(analysis)) {
    return {
      merits: true,
      reason: `standard_implementation with scope=${analysis.scope_breadth}, depth=${analysis.reasoning_depth}, risk=${analysis.risk_level}, files≈${analysis.estimated_files_touched ?? "?"}`,
    }
  }
  return { merits: false, reason: `task_type=${analysis.task_type} does not require planning` }
}

export interface AutoPlanningGateConfig {
  enabled?: boolean
  /** Analyzer model ID (default: claude-sonnet-4-6). */
  analyzerModelID?: string
  /** Timeout in ms for the analyzer call (default: 20000). */
  timeoutMs?: number
  /** Skip gate for these agents (default: empty — gate runs for any agent). */
  disabledAgents?: string[]
}

export interface AutoPlanningGateContext {
  directory: string
  client: PluginInput["client"]
}

export interface AutoPlanningGateOptions {
  ctx: AutoPlanningGateContext
  config?: AutoPlanningGateConfig
}

type SessionState = {
  sessionID: string
  analyzed: boolean
  injected: boolean
}

/**
 * Build the Prometheus delegation prompt that we inject into the session
 * when the gate fires. Design goals:
 *   1. Force the primary agent to pass the EXACT user text as prompt=
 *      (past bug: when this said "use user's request", LLMs paraphrased
 *      or passed the directive itself, so Prometheus got a vague prompt
 *      and idled in Interview Mode with 0 toolcalls).
 *   2. Tell Prometheus directly (via a marker it recognises) that the
 *      prompt it received IS the complete user brief — do not interview.
 *   3. Keep the injected block small so it doesn't dilute the user text
 *      in the prompt that Sisyphus eventually forwards.
 */
function buildPrometheusInjection(userPrompt: string, reason: string): string {
  const trimmed = userPrompt.trim().slice(0, 4000)
  return [
    "<auto_planning_gate>",
    `Task classifier: ${reason}. Planning is MANDATORY before implementation.`,
    "",
    "IMMEDIATELY invoke the task tool with these EXACT arguments:",
    "",
    '  subagent_type: "prometheus"',
    "  description: <short title capturing the task>",
    "  prompt: <COPY VERBATIM the text between the <user_brief> markers below — no paraphrase, no summary, no extra wrapping>",
    "",
    "<user_brief>",
    "[AUTO_PLANNING_GATE_FORWARDED_REQUEST]",
    trimmed,
    "</user_brief>",
    "",
    "After Prometheus returns a plan path (.sisyphus/plans/*.md), invoke Momus (task subagent_type=\"momus\") to review. If Momus rejects, loop back to Prometheus via session_id with Momus feedback. Only proceed to implementation once a reviewed plan exists.",
    "",
    "Do NOT paraphrase the user_brief. Do NOT start implementation before Momus approves.",
    "</auto_planning_gate>",
  ].join("\n")
}

/**
 * Persistent state file used to remember which sessions already went
 * through the gate. Survives process restarts (opencode run is a new
 * process each time) so `opencode run -s <id>` doesn't re-analyze a
 * session that was already classified in a previous invocation.
 */
const STATE_FILE_NAME = ".auto-planning-gate-state.json"

function stateFilePath(directory: string): string {
  return path.join(directory, ".sisyphus", STATE_FILE_NAME)
}

function loadPersistedSessions(directory: string): Set<string> {
  try {
    const raw = fs.readFileSync(stateFilePath(directory), "utf8")
    const parsed = JSON.parse(raw) as { analyzedSessions?: string[] }
    if (Array.isArray(parsed?.analyzedSessions)) {
      return new Set(parsed.analyzedSessions.filter((s) => typeof s === "string"))
    }
  } catch {
    // Missing or corrupt file — treat as empty state.
  }
  return new Set()
}

function persistSession(directory: string, sessionID: string): void {
  try {
    const file = stateFilePath(directory)
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const existing = loadPersistedSessions(directory)
    existing.add(sessionID)
    // Trim to last 200 sessions to prevent unbounded growth.
    const arr = Array.from(existing).slice(-200)
    fs.writeFileSync(file, JSON.stringify({ analyzedSessions: arr }, null, 2))
  } catch {
    // Best-effort persistence — do not crash the plugin if FS is r/o.
  }
}

export function createAutoPlanningGateHook(options: AutoPlanningGateOptions) {
  const config = options.config ?? {}
  if (config.enabled === false) {
    const noop = async () => {}
    return {
      "chat.message": noop,
      event: noop,
    }
  }

  const analyzerModelID = config.analyzerModelID ?? DEFAULT_ANALYZER_MODEL
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const disabledAgents = new Set(config.disabledAgents ?? [])

  // In-memory session state (fast path) plus filesystem persistence
  // (survives process restarts). Load the persisted set once on init.
  const sessions = new Map<string, SessionState>()
  const persistedAnalyzed = loadPersistedSessions(options.ctx.directory)

  const getState = (sessionID: string): SessionState => {
    let s = sessions.get(sessionID)
    if (!s) {
      // Session pre-analyzed in a previous process? Mark analyzed so we
      // skip re-classification + injection on this new process.
      const wasAnalyzed = persistedAnalyzed.has(sessionID)
      s = { sessionID, analyzed: wasAnalyzed, injected: wasAnalyzed }
      sessions.set(sessionID, s)
    }
    return s
  }

  const analyzeAndMaybeInject = async (params: {
    sessionID: string
    userText: string
    agent: string
  }): Promise<void> => {
    const state = getState(params.sessionID)
    if (state.analyzed) return
    state.analyzed = true
    persistSession(options.ctx.directory, params.sessionID)

    if (disabledAgents.has(params.agent)) {
      log(`[${HOOK_NAME}] skipped: agent ${params.agent} is in disabledAgents`, {
        sessionID: params.sessionID,
      })
      return
    }

    let result: AnalyzerResult
    try {
      result = await runAnalyzer({
        userPromptText: params.userText,
        agent: params.agent,
        turnNumber: 1,
        previousTierIfAny: null,
        analyzerModelID,
        timeoutMs,
      })
    } catch (error) {
      log(`[${HOOK_NAME}] analyzer threw`, {
        sessionID: params.sessionID,
        error: String(error),
      })
      return
    }

    if (!result.ok || !result.analysis) {
      log(`[${HOOK_NAME}] analyzer failed, skipping gate`, {
        sessionID: params.sessionID,
        error: result.error,
      })
      return
    }

    const verdict = meritsPlanning(result.analysis)
    log(`[${HOOK_NAME}] classification`, {
      sessionID: params.sessionID,
      task_type: result.analysis.task_type,
      scope_breadth: result.analysis.scope_breadth,
      risk_level: result.analysis.risk_level,
      merits: verdict.merits,
      reason: verdict.reason,
      durationMs: result.durationMs,
    })

    if (!verdict.merits) return

    // Inject the planning directive as a followup user message in the
    // same session. promptAsync (preferred, non-blocking) falls back to
    // prompt if unavailable. IMPORTANT: must call on the session object
    // to preserve `this` binding (the SDK wraps _client internally).
    const injection = buildPrometheusInjection(params.userText, verdict.reason)
    const body = {
      parts: [createInternalAgentTextPart(injection)],
    }
    try {
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
      if (!session.promptAsync && !session.prompt) {
        log(`[${HOOK_NAME}] neither promptAsync nor prompt available`, {
          sessionID: params.sessionID,
        })
        return
      }
      const args = {
        path: { id: params.sessionID },
        body,
        query: { directory: options.ctx.directory },
      }
      if (session.promptAsync) {
        await session.promptAsync(args)
      } else if (session.prompt) {
        await session.prompt(args)
      }
      state.injected = true
      log(`[${HOOK_NAME}] planning directive injected`, {
        sessionID: params.sessionID,
        reason: verdict.reason,
      })
    } catch (error) {
      log(`[${HOOK_NAME}] injection failed`, {
        sessionID: params.sessionID,
        error: String(error),
      })
    }
  }

  const removePersistedSession = (sessionID: string): void => {
    try {
      const file = stateFilePath(options.ctx.directory)
      if (!fs.existsSync(file)) return
      const raw = fs.readFileSync(file, "utf8")
      const parsed = JSON.parse(raw) as { analyzedSessions?: string[] }
      const filtered = (parsed.analyzedSessions ?? []).filter((s) => s !== sessionID)
      fs.writeFileSync(file, JSON.stringify({ analyzedSessions: filtered }, null, 2))
    } catch {
      // best-effort
    }
  }

  // Event handler — only for session cleanup (state clearing). The
  // main gate logic runs on `chat.message` which provides the
  // synchronous user prompt + parts directly.
  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined
    if (event.type === "session.deleted" || event.type === "session.compacted") {
      const info = (props?.info as { id?: string } | undefined) ?? undefined
      const sessionID = (props?.sessionID as string | undefined) ?? info?.id
      if (sessionID) {
        sessions.delete(sessionID)
        persistedAnalyzed.delete(sessionID)
        removePersistedSession(sessionID)
      }
    }
  }

  /**
   * chat.message handler — fires on every user turn with the full parts
   * array. We gate on `analyzed` flag (per session) so the analyzer
   * runs only on the FIRST user turn. This avoids re-analyzing during
   * multi-turn sessions.
   */
  const chatMessageHandler = async (
    input: { sessionID?: string; agent?: string },
    output: { parts?: Array<{ type?: string; text?: string; synthetic?: boolean }> },
  ): Promise<void> => {
    const sessionID = input.sessionID
    if (!sessionID) return

    const state = getState(sessionID)
    if (state.analyzed) return

    const parts = output.parts ?? []
    const userText = parts
      .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
      .map((p) => (p.text ?? "").trim())
      .filter((t) => t.length > 0)
      .join("\n")
    if (!userText) return
    // Skip if our own injection text is present (defensive).
    if (userText.includes("<auto_planning_gate>")) return

    const agent = input.agent ?? "primary"

    log(`[${HOOK_NAME}] chat.message triggered`, {
      sessionID,
      agent,
      userTextLen: userText.length,
      userTextPreview: userText.slice(0, 120),
    })

    // Fire and forget — the gate must NOT block the normal chat loop.
    analyzeAndMaybeInject({ sessionID, userText, agent }).catch((error) => {
      log(`[${HOOK_NAME}] analyzeAndMaybeInject threw`, {
        sessionID,
        error: String(error),
      })
    })
  }

  return {
    "chat.message": chatMessageHandler,
    event: eventHandler,
  }
}
