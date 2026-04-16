import { log } from "../../shared/logger"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import {
  classifyContinuation,
  intentPolicy,
  isInterruption,
} from "./analyzer/continuation-classifier"
import {
  buildContextSnapshot,
  estimateHistoryTokens,
  fetchSessionMessages,
} from "./analyzer/context-builder"
import { checkContextCompatibility, pickCompatibleTier } from "./router/context-compat"
import { resolveTierToModel } from "./router/decision-matrix"
import { detectExplicitModelRequest } from "./router/explicit-model-request"
import { MODEL_IDS } from "./constants"
import {
  clearSessionTokens,
  describeContextLoadWithFallback,
  setSessionTokens,
} from "./storage/session-token-tracker"
import {
  clearSessionState,
  cleanupStaleStates,
  loadSessionState,
  recordUserMessage,
  updateSessionState,
} from "./storage/session-state-store"
import type { ModelRouterConfig } from "./config"
import { parseModelRouterConfig } from "./config"
import { CACHE_MAX_ENTRIES, ROUTING_LOG_PATH } from "./constants"
import { routeDecision } from "./router/orchestrator"
import { appendDecision } from "./storage/decision-log"
import { DecisionCache } from "./storage/decision-cache"
import { clearSessionLock, withSessionLock } from "./session-mutex"
import { clearThreadState, completePlanPhase, getThreadState } from "./storage/thread-state"
import type { RoutingDecision, Tier } from "./types"
import { decideExecutionPlan } from "./router/subagent-decision"
import { buildSubagentPrompt } from "./router/subagent-prompt-builder"
import {
  appendSpawnIntent,
  defaultSpawnLogPath,
  sha256,
  summarizeAnalysis,
  type SpawnIntentRecord,
} from "./storage/spawn-intent-log"

/**
 * Router notification queue interface — shared with the fork's
 * processor.ts via globalThis. The processor creates the registry on
 * import, so we just access it here. Typed loosely to avoid coupling.
 */
interface RouterNotificationsApi {
  push(sessionID: string, text: string): void
}

function getRouterNotifications(): RouterNotificationsApi | null {
  const g = globalThis as unknown as Record<string, unknown>
  const api = g["__OPENCODE_ROUTER_NOTIFICATIONS__"] as RouterNotificationsApi | undefined
  return api ?? null
}

/**
 * Format a routing decision as a short human-readable line that renders
 * well in the TUI history. Shape matches the "⚡ Account switched → X"
 * precedent:
 *
 *   ◆ Router → opus · complex_refactor · 0.94
 *   ◇ Router → sonnet · rules_default
 *   · Router → haiku · all_minimalist_conditions_met · 0.97
 */
function formatRouterNotification(decision: RoutingDecision, executionMode?: "inline" | "spawn"): string {
  const tierSymbol: Record<string, string> = {
    opus: "◆",
    "opus-plan": "◆/◇",
    sonnet: "◇",
    haiku: "·",
  }
  const symbol = tierSymbol[decision.tier] ?? "◇"
  const reason = decision.reasons[0] ?? "default"
  const colon = reason.indexOf(":")
  const reasonClean = colon > 0 ? reason.slice(colon + 1) : reason
  const conf = decision.confidence > 0 ? ` · ${decision.confidence.toFixed(2)}` : ""
  const mode = executionMode === "spawn" ? " ⇢ subagent" : ""
  return `${symbol} Router → ${decision.tier} · ${reasonClean}${conf}${mode}`
}

function pushRouterNotification(
  sessionID: string,
  decision: RoutingDecision,
  executionMode?: "inline" | "spawn",
): void {
  const api = getRouterNotifications()
  if (!api) return
  try {
    api.push(sessionID, formatRouterNotification(decision, executionMode))
  } catch {
    // Non-fatal — notification is a UX feature, not core routing
  }
}

/**
 * Model router hook. Plugs into `chat.message` to analyze the incoming
 * user message, decide a model tier, and override `output.message.model`
 * so OpenCode's session loop uses the chosen model for the turn.
 *
 * Multi-turn aware: reuses previous decisions when the prompt hasn't
 * shifted. opus-plan state machine is managed here (plan vs execute phase).
 *
 * All decisions are appended to a JSONL log for observability and the
 * feedback-loop hook later enriches entries with outcome signals.
 */

export interface ModelRouterHookHandle {
  "chat.message": (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>
  event: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
  /**
   * Exposed for the slash command to query current decision.
   */
  getLastDecision: (sessionID: string) => RoutingDecision | null
  /**
   * Exposed for the slash command `/execute` to flip opus-plan to sonnet.
   */
  completePlanPhase: (sessionID: string) => void
}

/**
 * Plugin context type — minimal shape we use.
 * ctx.client.session.messages() lets us fetch session history for the
 * context-aware classifier.
 */
type MinimalPluginContext = {
  client?: {
    session?: {
      messages?: (args: {
        path: { id: string }
        query?: { directory?: string }
      }) => Promise<unknown>
    }
  }
  directory?: string
}

export function createModelRouterHook(
  rawConfig: unknown,
  ctx?: MinimalPluginContext,
): ModelRouterHookHandle {
  const config: ModelRouterConfig = parseModelRouterConfig(rawConfig)

  const cache = new DecisionCache({
    maxEntries: CACHE_MAX_ENTRIES,
    ttlMs: config.analyzer.cacheTtlMs,
  })

  const logPath = config.logPath ?? ROUTING_LOG_PATH

  // Kick off stale state cleanup in the background (non-blocking)
  cleanupStaleStates().catch(() => {})

  // Internal/hidden agents that should NEVER be re-routed. These are
  // system operations (compaction, title generation, summarization) that
  // must use the session's current model — not a router-chosen one.
  // Routing them can cause model mismatch errors (e.g., compaction with
  // haiku when the session was on opus).
  const INTERNAL_AGENTS = new Set([
    "compaction",
    "title",
    "summary",
  ])

  // Continuation detection is now fully delegated to the context-aware
  // classifier in analyzer/continuation-classifier.ts. It receives the
  // current tier, context load, and turn number, and decides based on
  // both the prompt AND the session state.

  /**
   * Helper: convert a model ID to a tier label ("opus" | "sonnet" | "haiku").
   */
  function tierLabelFromModel(model: { providerID: string; modelID: string } | undefined):
    | Tier
    | undefined {
    if (!model) return undefined
    const id = model.modelID.toLowerCase()
    if (id.includes("opus")) return "opus"
    if (id.includes("sonnet")) return "sonnet"
    if (id.includes("haiku")) return "haiku"
    return undefined
  }

  const chatMessageHandler: ModelRouterHookHandle["chat.message"] = async (input, output) => {
    if (!config.enabled) return
    if (!input.sessionID) return

    // Extract user prompt text from output.parts
    const promptText = (output.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.length > 0)
      .map((p) => p.text as string)
      .join("\n")
      .trim()

    if (!promptText) return // no text to analyze

    // ─── Camada 1: Session mutex — serialize per-session handlers ─────
    // Prevents race conditions when user sends multiple messages in rapid
    // succession (cancel stream → send next → cancel → send again).
    // Different sessions still run in parallel.
    return withSessionLock(input.sessionID, () => processTurn(input, output, promptText))
  }

  async function processTurn(
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
    promptText: string,
  ): Promise<void> {
    // ─── Guard 1: Skip internal/hidden agents ──────────────────────
    // Compaction, title, summary are system operations. Routing them
    // to a different model than the session's current model causes
    // errors (e.g., compaction with haiku when context was built on opus).
    const messageAgent = (output.message as Record<string, unknown>)["agent"]
    const agentStr = typeof messageAgent === "string" ? messageAgent : (input.agent ?? "")
    const agentKey = getAgentConfigKey(agentStr)
    if (INTERNAL_AGENTS.has(agentKey)) {
      log("[model-router] skipping internal agent", { agent: agentKey, sessionID: input.sessionID })
      return
    }

    // Resolve current model early — needed by guards below
    const currentModel =
      (output.message["model"] as { providerID: string; modelID: string } | undefined) ?? input.model
    const currentTierLabel = tierLabelFromModel(currentModel)

    // Hydrate in-memory state from disk on first touch. This handles
    // opencode restart / continue-session: we inherit token counts,
    // last decision, and turn count from the previous run.
    let existingState = getThreadState(input.sessionID)
    let persistedState = await loadSessionState(input.sessionID)
    if (!existingState && persistedState) {
      if (persistedState.tokens) {
        setSessionTokens(input.sessionID, {
          providerID: persistedState.tokens.providerID,
          modelID: persistedState.tokens.modelID,
          tokens: persistedState.tokens.tokens,
        })
      }
      log("[model-router] hydrated session state from disk", {
        sessionID: input.sessionID,
        turnCount: persistedState.turnCount,
        hasTokens: Boolean(persistedState.tokens),
        hasDecision: Boolean(persistedState.lastDecision),
      })
      existingState = getThreadState(input.sessionID)
    }

    const turnNumber = (existingState?.turnCount ?? persistedState?.turnCount ?? 0) + 1

    // ─── Camada 2: Context load with history fallback ─────────────────
    // Fetch session messages ALWAYS so we can estimate tokens even when
    // the message.updated tracker is stale (e.g., last stream was cancelled).
    const sessionMessages = await fetchSessionMessages(
      ctx?.client?.session as Parameters<typeof fetchSessionMessages>[0],
      input.sessionID,
      ctx?.directory,
    )
    const historyTokenEstimate = estimateHistoryTokens(sessionMessages)
    const contextInfo = describeContextLoadWithFallback({
      sessionID: input.sessionID,
      historyTokenEstimate,
    })
    log("[model-router] context load computed", {
      sessionID: input.sessionID,
      load: contextInfo.load,
      totalInputTokens: contextInfo.totalInputTokens,
      source: contextInfo.source,
      historyTokenEstimate,
      turnNumber,
    })

    // ─── Guard 2: Explicit model request ("utilize o opus") ──────────
    // User told us exactly what they want. Honor it — BUT pass through
    // the context-compat guard (Camada 6) so a haiku request in a 600k
    // session is upgraded to a compatible tier instead of blindly accepted.
    const explicit = detectExplicitModelRequest(promptText)
    if (explicit) {
      const requestedTier = explicit.tier as Tier
      const compatTier = pickCompatibleTier(requestedTier, contextInfo.totalInputTokens)
      const finalTier: Tier = compatTier ?? requestedTier
      const upgraded = finalTier !== requestedTier

      log("[model-router] explicit model request detected", {
        requested: requestedTier,
        final: finalTier,
        upgraded,
        match: explicit.matchedPattern,
        contextLoad: contextInfo.load,
        totalInputTokens: contextInfo.totalInputTokens,
        sessionID: input.sessionID,
      })

      const resolved = resolveTierToModel(finalTier, existingState ?? undefined)
      output.message["model"] = { providerID: resolved.providerID, modelID: resolved.modelID }

      const reasons: string[] = [`explicit:${explicit.matchedPattern}`]
      if (upgraded) {
        reasons.unshift(
          `context_guard:${requestedTier}→${finalTier}(${contextInfo.totalInputTokens}tok)`,
        )
      }

      const decision: RoutingDecision = {
        timestamp: Date.now(),
        sessionID: input.sessionID,
        turnNumber,
        agent: agentStr || "build",
        tier: resolved.tier,
        modelID: resolved.modelID,
        providerID: resolved.providerID,
        reasons,
        analysis: null,
        analyzer: {
          used: false,
          durationMs: 0,
          model: "",
          fallbackUsed: false,
          cached: false,
        },
        confidence: upgraded ? 0.8 : 1.0,
      }
      pushRouterNotification(input.sessionID, decision)
      if (config.logDecisions) {
        await appendDecision(logPath, decision)
      }
      await updateSessionState(input.sessionID, {
        turnCount: turnNumber,
        lastDecision: decision,
        lastCwd: ctx?.directory ?? null,
      })
      await recordUserMessage(input.sessionID, promptText, decision.tier)
      return
    }

    // ─── Guard 3: Context-aware continuation classification ─────────
    // Multi-intent classifier (Haiku) decides 1 of 7 intents. Each intent
    // maps to preserve/reanalyze via intentPolicy(). Five of seven intents
    // preserve the current tier without touching the analyzer, cutting
    // Sonnet analyzer calls by ~70% in typical sessions.
    if (turnNumber > 1) {
      const contextSnapshot = buildContextSnapshot({
        currentPrompt: promptText,
        messages: sessionMessages,
        persistedState,
        currentCwdHint: ctx?.directory,
      })

      const classification = await classifyContinuation({
        promptText,
        currentTier: currentTierLabel,
        contextLoad: contextInfo.load,
        totalInputTokens: contextInfo.totalInputTokens,
        turnNumber,
        contextSnapshot,
      })

      log("[model-router] continuation classifier", {
        intent: classification.intent,
        reason: classification.reason,
        policy: intentPolicy(classification.intent),
        contextLoad: contextInfo.load,
        totalInputTokens: contextInfo.totalInputTokens,
        cwdChanged: contextSnapshot.cwdChanged,
        turnGapMinutes: contextSnapshot.turnGapMinutes,
        jaccardWithLast: contextSnapshot.jaccardWithLast,
        durationMs: classification.durationMs,
        llmUsed: classification.llmUsed,
        error: classification.error,
        prompt: promptText.slice(0, 80),
        sessionID: input.sessionID,
      })

      const policy = intentPolicy(classification.intent)
      if (policy === "preserve") {
        // Preserve current tier. Do NOT mutate output.message.model.
        // Interruption intent: also skip turn count increment.
        if (!isInterruption(classification.intent)) {
          await updateSessionState(input.sessionID, {
            turnCount: turnNumber,
            // keep existing lastDecision — this is a continuation
            lastCwd: ctx?.directory ?? null,
          })
          await recordUserMessage(input.sessionID, promptText, currentTierLabel ?? "unknown")
        }
        return
      }
      // reanalyze → fall through to normal routing below
    }

    // agentStr and agentKey were already resolved above (guard 1).
    // Reuse them for the routing context.
    const resolvedAgent = agentStr || "build"

    try {
      const decision = await routeDecision(
        {
          sessionID: input.sessionID,
          turnNumber,
          agent: resolvedAgent,
          currentModel,
          userPromptText: promptText,
          previousDecisions: [], // not used in v1 orchestrator
          currentTotalInputTokens: contextInfo.totalInputTokens,
          contextLoad: contextInfo.load,
          currentTierLabel,
        },
        { config, cache },
      )

      // Mutate output.message.model only if the decision differs from
      // the current setting. Avoids unnecessary churn when the router
      // picks the same tier the user was already going to use.
      const currentModelValue = output.message["model"] as
        | { providerID?: string; modelID?: string }
        | undefined
      const needsSwap =
        !currentModelValue ||
        currentModelValue.providerID !== decision.providerID ||
        currentModelValue.modelID !== decision.modelID

      // Subagent isolation decision. In shadow mode, we record the plan
      // and the generated subagent prompt without altering behavior — the
      // inline model swap below still happens. In spawn mode, the hook
      // will (eventually) dispatch to the Task tool instead of swapping.
      const executionPlan = decideExecutionPlan({
        decision,
        ctx: {
          sessionID: input.sessionID,
          turnNumber,
          agent: resolvedAgent,
          currentModel,
          userPromptText: promptText,
          previousDecisions: [],
          currentTotalInputTokens: contextInfo.totalInputTokens,
          contextLoad: contextInfo.load,
          currentTierLabel,
        },
      })
      const isolation = config.subagentIsolation
      const isolationActive = isolation && isolation.mode !== "disabled" && executionPlan.mode === "spawn"

      if (isolationActive && decision.analysis) {
        const prompt = buildSubagentPrompt({
          originalUserMessage: promptText,
          plan: executionPlan,
          analysis: decision.analysis,
          parent: {
            sessionID: input.sessionID,
            modelID: currentModel?.modelID ?? "",
            providerID: currentModel?.providerID ?? "",
            cwd: ctx?.directory ?? process.cwd(),
          },
        })
        const record: SpawnIntentRecord = {
          version: 1,
          timestamp: Date.now(),
          sessionID: input.sessionID,
          turnNumber,
          parentAgent: resolvedAgent,
          parentModel: {
            providerID: currentModel?.providerID ?? "",
            modelID: currentModel?.modelID ?? "",
          },
          plan: executionPlan,
          decisionTier: decision.tier,
          decisionReasons: decision.reasons,
          analysisSummary: summarizeAnalysis(decision),
          subagentPromptPreview: prompt.slice(0, 500),
          subagentPromptSha256: await sha256(prompt),
          mode: isolation.mode as "shadow" | "spawn",
        }
        await appendSpawnIntent(defaultSpawnLogPath(), record)

        // TODO (spawn mode): call the spawner to actually launch the
        // subagent. Kept behind the flag until the escalation loop + sync
        // wait integration is wired to the Task tool or delegate-task sync
        // poller. See router/subagent-decision.ts for the decision output.
      }

      if (needsSwap) {
        output.message["model"] = {
          providerID: decision.providerID,
          modelID: decision.modelID,
        }
      }

      // Push a synthetic notification to the fork's router-notifications
      // queue so the processor can render it as an inline history
      // message (same pattern as account switch notifications).
      pushRouterNotification(input.sessionID, decision, executionPlan.mode)

      if (config.logDecisions) {
        await appendDecision(logPath, decision)
      }

      // Persist session state to disk so future sessions can hydrate
      // (survives opencode restarts and -c continue).
      await updateSessionState(input.sessionID, {
        turnCount: turnNumber,
        lastDecision: decision,
        lastCwd: ctx?.directory ?? null,
      })
      await recordUserMessage(input.sessionID, promptText, decision.tier)
    } catch (e) {
      log("[model-router] unexpected error, letting default model through", {
        error: String(e),
        sessionID: input.sessionID,
      })
      // Intentionally NOT throwing — routing failures must never break the session
    }
  }

  const eventHandler: ModelRouterHookHandle["event"] = async (input) => {
    if (!config.enabled) return
    const ev = input.event
    if (!ev) return

    const props = (ev.properties ?? {}) as Record<string, unknown>

    // ─── session.deleted: full cleanup ────────────────────────────────
    if (ev.type === "session.deleted") {
      const info = props.info as { id?: string } | undefined
      const sessionID = info?.id ?? (props.sessionID as string | undefined)
      if (sessionID) {
        clearThreadState(sessionID)
        clearSessionTokens(sessionID)
        clearSessionState(sessionID)
        clearSessionLock(sessionID)
      }
      return
    }

    // ─── Camada 7: session.compacted handshake ────────────────────────
    // On compaction, we RESET the token tracker (context window is now
    // small again) but PRESERVE lastDecision so the first post-compaction
    // turn inherits the tier instead of being treated as turn 1 (which
    // would trigger reanalyze and could pick a different tier).
    if (ev.type === "session.compacted") {
      const info = props.info as { id?: string } | undefined
      const sessionID = info?.id ?? (props.sessionID as string | undefined)
      if (sessionID) {
        clearSessionTokens(sessionID)
        log("[model-router] session compacted — token tracker reset, lastDecision preserved", {
          sessionID,
        })
        // Do NOT clear threadState, sessionState, or sessionLock.
        // Those carry forward so turn N+1 sees itself as a continuation
        // of a fresh-but-same-tier context.
      }
      return
    }

    if (ev.type === "message.updated") {
      const info = props.info as
        | {
            sessionID?: string
            role?: string
            finish?: boolean
            providerID?: string
            modelID?: string
            tokens?: {
              input: number
              output: number
              reasoning: number
              cache: { read: number; write: number }
            }
          }
        | undefined
      if (!info) return

      const sessionID = info.sessionID
      if (!sessionID) return

      // ─── Track token usage for context-load detection ─────────────
      if (info.role === "assistant" && info.finish && info.providerID && info.modelID && info.tokens) {
        const snapshot = {
          providerID: info.providerID,
          modelID: info.modelID,
          tokens: info.tokens,
        }
        setSessionTokens(sessionID, snapshot)
        // Persist to disk so future sessions see the token accumulation
        void updateSessionState(sessionID, {
          tokens: { ...snapshot, updatedAt: Date.now() },
        })
      }

      // ─── opus-plan state machine ──────────────────────────────────
      const state = getThreadState(sessionID)
      if (!state?.lastDecision) return
      if (state.lastDecision.tier !== "opus-plan") return
      if (state.planPhaseComplete) return

      const parts = props.parts as Array<{ type?: string; toolInvocation?: { toolName?: string } }> | undefined
      if (!Array.isArray(parts)) return
      const editToolNames = new Set(["edit", "write", "apply_patch", "multiedit"])
      const hasEditCall = parts.some(
        (p) => p.type === "tool-invocation" && editToolNames.has((p.toolInvocation?.toolName ?? "").toLowerCase()),
      )
      if (hasEditCall) {
        completePlanPhase(sessionID)
        log("[model-router] opus-plan: plan phase complete, flipping to execute (sonnet)", { sessionID })
      }
    }
  }

  return {
    "chat.message": chatMessageHandler,
    event: eventHandler,
    getLastDecision: (sessionID: string) => getThreadState(sessionID)?.lastDecision ?? null,
    completePlanPhase: (sessionID: string) => completePlanPhase(sessionID),
  }
}
