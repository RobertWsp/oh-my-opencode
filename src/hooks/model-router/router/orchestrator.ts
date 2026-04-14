import { log } from "../../../shared/logger"
import { getAgentConfigKey } from "../../../shared/agent-display-names"
import type { ModelRouterConfig } from "../config"
import { AGENT_TIER_OVERRIDES, SHIFT_MARKERS } from "../constants"
import { runAnalyzer } from "../analyzer/run-analyzer"
import { runPreScreen } from "../analyzer/haiku-pre-screen"
import { DecisionCache } from "../storage/decision-cache"
import { getOrCreateThreadState, recordDecision } from "../storage/thread-state"
import type { RoutingContext, RoutingDecision, ThreadState, Tier } from "../types"
import { checkContextCompatibility, pickCompatibleTier } from "./context-compat"
import { buildDecision, decideFromAnalysis, resolveTierToModel } from "./decision-matrix"
import { detectCommand, enrichPromptForAnalyzer } from "./command-overrides"
import { rulesFallback } from "./rules-fallback"

/**
 * Context compatibility guard — applied to every decision before it's
 * returned. If the chosen tier can't hold the session's current
 * accumulated tokens (e.g., Sonnet 200k effective via Max can't hold a
 * 700k Opus session), upgrade to the smallest tier that CAN hold them.
 *
 * Mutates the decision in-place and adds a reason tag so the guard is
 * visible in the decision log and TUI notification.
 */
function applyContextCompatGuard(
  decision: RoutingDecision,
  ctx: RoutingContext,
  threadState: ThreadState | undefined,
): void {
  const tokens = ctx.currentTotalInputTokens ?? 0
  if (tokens <= 0) return // no tracking yet — can't guard

  const check = checkContextCompatibility(decision.tier, tokens)
  if (check.compatible) return // fits — nothing to do

  const upgraded = pickCompatibleTier(decision.tier, tokens)
  if (!upgraded || upgraded === decision.tier) {
    // Nothing bigger fits either — mark the decision but leave the tier
    // (orchestrator shouldn't block session; downstream compaction will
    // surface the real error if it happens).
    decision.reasons.unshift(`context_guard:NO_FIT(${tokens}tok>${check.usableLimit})`)
    return
  }

  const resolved = resolveTierToModel(upgraded, threadState)
  const originalTier = decision.tier
  decision.tier = resolved.tier
  decision.modelID = resolved.modelID
  decision.providerID = resolved.providerID
  // Put the guard reason FIRST so it surfaces prominently in the TUI
  // notification (which shows decision.reasons[0]).
  decision.reasons.unshift(
    `context_guard:${originalTier}→${upgraded}(${tokens}tok>${check.usableLimit}usable)`,
  )
  log("[model-router] context-compat guard triggered", {
    sessionID: ctx.sessionID,
    originalTier,
    upgradedTo: upgraded,
    totalInputTokens: tokens,
    targetUsableLimit: check.usableLimit,
  })
}

/**
 * Decide whether to re-run the analyzer or reuse the previous turn's
 * decision. Cheap, rule-based — runs on EVERY turn.
 *
 * Returns true if the analyzer must run again.
 */
export function shouldReanalyze(
  threadState: ThreadState,
  newPromptText: string,
  jaccardThreshold: number,
): { reanalyze: boolean; reason: string } {
  // First turn: always analyze
  if (threadState.turnCount === 0) return { reanalyze: true, reason: "first_turn" }

  // If last decision is missing, something weird happened — analyze again
  if (!threadState.lastDecision) return { reanalyze: true, reason: "no_previous_decision" }

  // If opus-plan just flipped phases, the analyzer is not needed — we just
  // downgrade the model. This case returns false here and the orchestrator
  // re-resolves the model.
  if (threadState.lastDecision.tier === "opus-plan") {
    return { reanalyze: false, reason: "opus_plan_phase_resolve" }
  }

  // Shift markers in the new prompt → re-analyze
  const lowered = newPromptText.toLowerCase()
  for (const marker of SHIFT_MARKERS) {
    if (lowered.includes(marker)) {
      return { reanalyze: true, reason: `shift_marker:${marker}` }
    }
  }

  // Jaccard similarity against last prompt
  const sim = jaccard(threadState.lastPromptText, newPromptText)
  if (sim < jaccardThreshold) {
    return { reanalyze: true, reason: `jaccard=${sim.toFixed(2)}<${jaccardThreshold}` }
  }

  return { reanalyze: false, reason: `jaccard=${sim.toFixed(2)}>=${jaccardThreshold}` }
}

/**
 * Jaccard similarity between two texts on word-level.
 */
function jaccard(a: string, b: string): number {
  const wordsA = new Set(tokenize(a))
  const wordsB = new Set(tokenize(b))
  if (wordsA.size === 0 && wordsB.size === 0) return 1
  let inter = 0
  for (const w of wordsA) if (wordsB.has(w)) inter += 1
  const union = wordsA.size + wordsB.size - inter
  return union === 0 ? 0 : inter / union
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3) // skip stopwords-ish
}

// ─────────────────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  config: ModelRouterConfig
  cache: DecisionCache
}

/**
 * Main entry point: given a routing context, return a final decision.
 *
 * Flow:
 *   1. Check thread state — can we reuse the last decision?
 *      - opus-plan: re-resolve model if plan phase changed
 *      - shift detected: re-analyze
 *      - similar prompt: reuse
 *   2. Check cache (prompt hash match within TTL)
 *   3. Run analyzer (unless strategy=rules_only)
 *   4. If analyzer fails, fallback to rules (unless strategy=analyzer_only)
 *   5. Apply decision matrix to analysis (or rules result)
 *   6. Build and record the decision
 */
export async function routeDecision(
  ctx: RoutingContext,
  opts: OrchestratorOptions,
): Promise<RoutingDecision> {
  const { config, cache } = opts
  const threadState = getOrCreateThreadState(ctx.sessionID)

  // ─── 0a. Agent override short-circuit ─────────────────────────────────
  // Agents with a forced tier (explore→haiku, oracle→opus, librarian→haiku)
  // should NEVER touch the LLM analyzer or pre-screen — that wastes 2-20s
  // per call with a pre-determined result. Run the override BEFORE all
  // other routing logic.
  const agentKey = getAgentConfigKey(ctx.agent)
  const mergedOverrides = { ...AGENT_TIER_OVERRIDES, ...(config.agentOverrides ?? {}) }
  const agentForcedTier = mergedOverrides[agentKey]
  if (agentForcedTier) {
    const decision = buildDecision({
      analysis: null,
      ctx,
      tier: agentForcedTier,
      reasons: [`agent:${agentKey}→${agentForcedTier}`],
      analyzerUsed: false,
      analyzerDurationMs: 0,
      analyzerModel: config.analyzer.modelID,
      analyzerFallbackUsed: false,
      cached: false,
      threadState,
    })
    applyContextCompatGuard(decision, ctx, threadState)
    recordDecision(ctx.sessionID, decision, ctx.userPromptText)
    return decision
  }

  // ─── 0b. Slash command detection ──────────────────────────────────────
  // Commands like /resolve-task expand into generic templates. We detect
  // them and either:
  //   (a) Force a tier for commands with FIXED complexity (senior-review → opus always)
  //   (b) Enrich the prompt for the analyzer for VARIABLE commands (resolve-task)
  const command = detectCommand(ctx.userPromptText)
  if (command && command.forcedTier) {
    // Fixed complexity command → force tier immediately
    const decision = buildDecision({
      analysis: null,
      ctx,
      tier: command.forcedTier,
      reasons: [`command:${command.name}→${command.forcedTier} (${command.complexityProfile})`],
      analyzerUsed: false,
      analyzerDurationMs: 0,
      analyzerModel: config.analyzer.modelID,
      analyzerFallbackUsed: false,
      cached: false,
      threadState,
    })
    applyContextCompatGuard(decision, ctx, threadState)
    cache.set(DecisionCache.hashPrompt(
      ctx.userPromptText,
      ctx.agent,
      ctx.contextLoad ?? "unknown",
      ctx.currentTierLabel ?? "unknown",
    ), decision)
    recordDecision(ctx.sessionID, decision, ctx.userPromptText)
    return decision
  }
  // For variable commands, we enrich the prompt text for the analyzer
  // below (step 3). The original ctx.userPromptText is replaced with
  // enriched text that includes the workflow description + extracted args.
  const analyzerPromptText = command
    ? enrichPromptForAnalyzer(ctx.userPromptText, command)
    : ctx.userPromptText

  // ─── 1. Multi-turn reuse ──────────────────────────────────────────────
  const reanalyzeDecision = shouldReanalyze(threadState, ctx.userPromptText, config.reanalyzeJaccardThreshold)

  if (!reanalyzeDecision.reanalyze && threadState.lastDecision) {
    const reused = { ...threadState.lastDecision, reasons: [...threadState.lastDecision.reasons] }
    // opus-plan tier: re-resolve modelID if phase changed
    if (reused.tier === "opus-plan") {
      const resolved = resolveTierToModel("opus-plan", threadState)
      reused.modelID = resolved.modelID
      reused.providerID = resolved.providerID
      reused.reasons.push(`reuse:${reanalyzeDecision.reason}`, `phase=${resolved.phase ?? "plan"}`)
    } else {
      reused.reasons.push(`reuse:${reanalyzeDecision.reason}`)
    }
    reused.turnNumber = ctx.turnNumber
    applyContextCompatGuard(reused, ctx, threadState)
    recordDecision(ctx.sessionID, reused, ctx.userPromptText)
    return reused
  }

  // ─── 2. Cache ─────────────────────────────────────────────────────────
  const cacheKey = DecisionCache.hashPrompt(
      ctx.userPromptText,
      ctx.agent,
      ctx.contextLoad ?? "unknown",
      ctx.currentTierLabel ?? "unknown",
    )
  const cached = cache.get(cacheKey)
  if (cached) {
    const decision: RoutingDecision = {
      ...cached,
      timestamp: Date.now(),
      sessionID: ctx.sessionID,
      turnNumber: ctx.turnNumber,
      reasons: [...cached.reasons, "cache:hit"],
      analyzer: { ...cached.analyzer, cached: true },
    }
    applyContextCompatGuard(decision, ctx, threadState)
    recordDecision(ctx.sessionID, decision, ctx.userPromptText)
    return decision
  }

  // ─── 3. Pre-screen (Haiku) + analyzer (Sonnet) in parallel ───────────
  // Race strategy:
  //   - Fire BOTH pre-screen and analyzer simultaneously
  //   - Wait for pre-screen first (Haiku ~700ms)
  //   - If pre-screen says "certain": use it, analyzer result discarded
  //     (the Sonnet call completes in the background — we could abort but
  //      don't, since Anthropic counts it as initiated regardless)
  //   - If pre-screen says "escalate" or "unavailable": await analyzer
  //
  // Latency profile:
  //   - Happy path (certain):      ~700ms (pre-screen wins)
  //   - Escalated path:            ~2.5s  (whichever comes later)
  //   - Pre-screen timeout (6s):   ~2.5s (analyzer usually already done)
  //
  // Rate-limit profile:
  //   - Pre-screen: Haiku bucket (generous under Max)
  //   - Analyzer:   Sonnet bucket (stricter, so parallel execution is OK
  //                 because Meridian distributes across 6 profiles)
  let preScreenShortCircuit: { tier: Tier; reasons: string[] } | null = null
  let analysis = null
  let analyzerUsed = false
  let analyzerDurationMs = 0
  let analyzerFallbackUsed = false
  let analyzerError: string | undefined

  const preScreenEnabled =
    config.strategy !== "rules_only" && config.preScreen?.enabled !== false

  if (config.strategy !== "rules_only") {
    const analyzerPromise = runAnalyzer({
      userPromptText: analyzerPromptText,
      agent: ctx.agent,
      turnNumber: ctx.turnNumber,
      previousTierIfAny: threadState.lastDecision?.tier ?? null,
      analyzerModelID: config.analyzer.modelID,
      timeoutMs: config.analyzer.timeoutMs,
    })

    if (preScreenEnabled) {
      // Race: pre-screen first, but analyzer keeps running
      const prePromise = runPreScreen({
        userPromptText: analyzerPromptText,
        agent: ctx.agent,
        turnNumber: ctx.turnNumber,
        previousTierIfAny: threadState.lastDecision?.tier ?? null,
      })

      const pre = await prePromise
      log("[model-router] haiku pre-screen", {
        decision: pre.decision,
        durationMs: pre.durationMs,
        sessionID: ctx.sessionID,
      })

      if (pre.decision.kind === "certain") {
        preScreenShortCircuit = {
          tier: pre.decision.tier,
          reasons: [
            `pre_screen:${pre.decision.tier}(${pre.decision.confidence.toFixed(2)})`,
          ],
        }
        // Discard the analyzer promise — we won't read its result.
        // Attach a catch so its rejection doesn't become an unhandled error.
        analyzerPromise.catch(() => undefined)
      }
    }

    // Pre-screen didn't short-circuit → await the analyzer (which we
    // kicked off in parallel, so this is free latency in the happy case).
    if (!preScreenShortCircuit) {
      const result = await analyzerPromise
      analyzerUsed = true
      analyzerDurationMs = result.durationMs
      analysis = result.analysis
      if (!result.ok) {
        analyzerError = result.error
        analyzerFallbackUsed = true
        log("[model-router] analyzer failed, falling back", { error: result.error })
      }
    }
  }

  // ─── 4. Decide ────────────────────────────────────────────────────────
  let tier: Tier
  let reasons: string[]

  if (preScreenShortCircuit) {
    tier = preScreenShortCircuit.tier
    reasons = preScreenShortCircuit.reasons
  } else if (analysis) {
    const decision = decideFromAnalysis(analysis, ctx, {
      agentOverrides: config.agentOverrides as Record<string, any>,
      enableOpusPlan: true,
    })
    tier = decision.tier
    reasons = decision.reasons
  } else {
    if (config.strategy === "analyzer_only") {
      tier = "sonnet"
      reasons = ["sonnet:analyzer_required_but_failed", analyzerError ?? "unknown"]
    } else {
      // For variable commands, run rules against the enriched prompt so
      // keywords from the workflow description can match.
      const rulesCtx = command ? { ...ctx, userPromptText: analyzerPromptText } : ctx
      const fb = rulesFallback(rulesCtx)
      tier = fb.tier
      reasons = fb.reasons
      if (command) reasons.push(`command:${command.name}(variable)`)
    }
  }

  // ─── 5. Build decision ────────────────────────────────────────────────
  const decision = buildDecision({
    analysis,
    ctx,
    tier,
    reasons,
    analyzerUsed,
    analyzerDurationMs,
    analyzerModel: config.analyzer.modelID,
    analyzerFallbackUsed,
    cached: false,
    analyzerError,
    threadState,
  })

  // ─── 6. Context-compat guard (last line of defense) ───────────────────
  applyContextCompatGuard(decision, ctx, threadState)

  // ─── 7. Cache + record ────────────────────────────────────────────────
  cache.set(cacheKey, decision)
  recordDecision(ctx.sessionID, decision, ctx.userPromptText)

  return decision
}
