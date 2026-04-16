import { readFile } from "node:fs/promises"
import type { RoutingDecision, RoutingOutcome, Tier } from "../types"

/**
 * Stats module — aggregates routing decisions from the JSONL log.
 * Decision records and outcome records are joined by { sessionID, decisionTs }.
 *
 * Used by:
 *   - /model stats slash command
 *   - TUI status line ("Opus: 23%" footer summary)
 *   - Manual audit
 */

type LogLine =
  | { kind: "decision"; ts: number; data: RoutingDecision }
  | { kind: "outcome"; ts: number; sessionID: string; decisionTs: number; data: RoutingOutcome }

export interface RoutingStats {
  windowDays: number
  totalDecisions: number
  tierDistribution: Record<Tier, number>
  tierPercentages: Record<Tier, number>
  avgAnalyzerDurationMs: number
  analyzerFallbackCount: number
  cacheHits: number
  // Outcome-joined stats
  outcomesJoined: number
  successRateByTier: Record<Tier, { total: number; successful: number; rate: number }>
  avgOutcomeScore: number
  // Reasons histogram (top 10)
  topReasons: Array<{ reason: string; count: number }>
  // Subagent isolation stats
  subagent: {
    totalSpawns: number
    completions: number
    successRate: number
    avgDurationMs: number
    escalationsRequested: number
    escalationRate: number // escalations / completions
    byIntent: Record<string, number>
  }
}

const EMPTY_TIER_RECORD = (): Record<Tier, number> => ({ haiku: 0, sonnet: 0, opus: 0, "opus-plan": 0 })

export async function computeStats(logPath: string, windowDays: number = 7): Promise<RoutingStats> {
  let content = ""
  try {
    content = await readFile(logPath, "utf-8")
  } catch {
    // File doesn't exist yet — return zero stats
    return emptyStats(windowDays)
  }

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000

  const decisions = new Map<string, RoutingDecision>() // keyed by `${sessionID}:${ts}`
  const outcomes = new Map<string, RoutingOutcome>()

  const lines = content.split("\n").filter((l) => l.trim())
  for (const line of lines) {
    let parsed: LogLine
    try {
      parsed = JSON.parse(line) as LogLine
    } catch {
      continue
    }
    if (parsed.ts < cutoff) continue

    if (parsed.kind === "decision") {
      const key = `${parsed.data.sessionID}:${parsed.data.timestamp}`
      decisions.set(key, parsed.data)
    } else if (parsed.kind === "outcome") {
      const key = `${parsed.sessionID}:${parsed.decisionTs}`
      outcomes.set(key, parsed.data)
    }
  }

  const tierDist = EMPTY_TIER_RECORD()
  let analyzerDurationSum = 0
  let analyzerDurationCount = 0
  let analyzerFallbackCount = 0
  let cacheHits = 0
  const reasonCounts = new Map<string, number>()

  for (const d of decisions.values()) {
    tierDist[d.tier] = (tierDist[d.tier] ?? 0) + 1
    if (d.analyzer.durationMs > 0) {
      analyzerDurationSum += d.analyzer.durationMs
      analyzerDurationCount++
    }
    if (d.analyzer.fallbackUsed) analyzerFallbackCount++
    if (d.analyzer.cached) cacheHits++
    for (const reason of d.reasons) {
      // Normalize reason by dropping after ":" (keep category)
      const cat = reason.split(":")[0] ?? reason
      reasonCounts.set(cat, (reasonCounts.get(cat) ?? 0) + 1)
    }
  }

  const totalDecisions = decisions.size
  const tierPct: Record<Tier, number> = EMPTY_TIER_RECORD()
  if (totalDecisions > 0) {
    for (const tier of Object.keys(tierDist) as Tier[]) {
      tierPct[tier] = tierDist[tier] / totalDecisions
    }
  }

  // Outcome join
  const successByTier: Record<Tier, { total: number; successful: number; rate: number }> = {
    haiku: { total: 0, successful: 0, rate: 0 },
    sonnet: { total: 0, successful: 0, rate: 0 },
    opus: { total: 0, successful: 0, rate: 0 },
    "opus-plan": { total: 0, successful: 0, rate: 0 },
  }
  let scoreSum = 0
  let outcomesJoined = 0
  let subagentCompletions = 0
  let subagentSuccesses = 0
  let subagentDurationSum = 0
  let subagentDurationCount = 0
  let escalationsRequested = 0
  const intentCounts = new Map<string, number>()
  for (const [key, outcome] of outcomes) {
    const decision = decisions.get(key)
    if (!decision) continue
    outcomesJoined++
    scoreSum += outcome.score
    const bucket = successByTier[decision.tier]
    bucket.total++
    if (outcome.score > 0) bucket.successful++

    const sig = outcome.signals
    if (sig.subagentUsed) {
      subagentCompletions++
      if (outcome.score > 0 && !sig.escalationRequested) subagentSuccesses++
      if (typeof sig.subagentDurationMs === "number" && sig.subagentDurationMs > 0) {
        subagentDurationSum += sig.subagentDurationMs
        subagentDurationCount++
      }
    }
    if (sig.escalationRequested) escalationsRequested++
    const intent = decision.analysis?.detected_intent
    if (intent && (intent as string) !== "none") {
      intentCounts.set(intent as string, (intentCounts.get(intent as string) ?? 0) + 1)
    }
  }
  for (const tier of Object.keys(successByTier) as Tier[]) {
    const b = successByTier[tier]
    b.rate = b.total > 0 ? b.successful / b.total : 0
  }

  const topReasons = Array.from(reasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }))

  const byIntent: Record<string, number> = {}
  for (const [k, v] of intentCounts) byIntent[k] = v

  return {
    windowDays,
    totalDecisions,
    tierDistribution: tierDist,
    tierPercentages: tierPct,
    avgAnalyzerDurationMs: analyzerDurationCount > 0 ? analyzerDurationSum / analyzerDurationCount : 0,
    analyzerFallbackCount,
    cacheHits,
    outcomesJoined,
    successRateByTier: successByTier,
    avgOutcomeScore: outcomesJoined > 0 ? scoreSum / outcomesJoined : 0,
    topReasons,
    subagent: {
      totalSpawns: subagentCompletions,
      completions: subagentCompletions,
      successRate: subagentCompletions > 0 ? subagentSuccesses / subagentCompletions : 0,
      avgDurationMs: subagentDurationCount > 0 ? subagentDurationSum / subagentDurationCount : 0,
      escalationsRequested,
      escalationRate: subagentCompletions > 0 ? escalationsRequested / subagentCompletions : 0,
      byIntent,
    },
  }
}

function emptyStats(windowDays: number): RoutingStats {
  return {
    windowDays,
    totalDecisions: 0,
    tierDistribution: EMPTY_TIER_RECORD(),
    tierPercentages: EMPTY_TIER_RECORD(),
    avgAnalyzerDurationMs: 0,
    analyzerFallbackCount: 0,
    cacheHits: 0,
    outcomesJoined: 0,
    successRateByTier: {
      haiku: { total: 0, successful: 0, rate: 0 },
      sonnet: { total: 0, successful: 0, rate: 0 },
      opus: { total: 0, successful: 0, rate: 0 },
      "opus-plan": { total: 0, successful: 0, rate: 0 },
    },
    avgOutcomeScore: 0,
    topReasons: [],
    subagent: {
      totalSpawns: 0,
      completions: 0,
      successRate: 0,
      avgDurationMs: 0,
      escalationsRequested: 0,
      escalationRate: 0,
      byIntent: {},
    },
  }
}

export function formatStatsAsText(stats: RoutingStats): string {
  if (stats.totalDecisions === 0) {
    return `No routing decisions in the last ${stats.windowDays}d. Enable model_router in config and start a session.`
  }

  const lines: string[] = []
  lines.push(`Routing stats (last ${stats.windowDays} days)`)
  lines.push(`  Total decisions: ${stats.totalDecisions}`)
  lines.push("")
  lines.push("  Tier distribution:")
  for (const tier of ["opus", "opus-plan", "sonnet", "haiku"] as Tier[]) {
    const count = stats.tierDistribution[tier]
    const pct = (stats.tierPercentages[tier] * 100).toFixed(1)
    lines.push(`    ${tier.padEnd(10)} ${String(count).padStart(5)}  (${pct}%)`)
  }
  lines.push("")
  lines.push(`  Avg analyzer latency: ${Math.round(stats.avgAnalyzerDurationMs)}ms`)
  lines.push(`  Cache hits: ${stats.cacheHits} (${stats.totalDecisions > 0 ? ((stats.cacheHits / stats.totalDecisions) * 100).toFixed(1) : 0}%)`)
  lines.push(`  Analyzer fallbacks: ${stats.analyzerFallbackCount}`)

  if (stats.outcomesJoined > 0) {
    lines.push("")
    lines.push("  Success rates (from outcome signals):")
    for (const tier of ["opus", "opus-plan", "sonnet", "haiku"] as Tier[]) {
      const b = stats.successRateByTier[tier]
      if (b.total === 0) continue
      lines.push(`    ${tier.padEnd(10)} ${(b.rate * 100).toFixed(0)}% (${b.successful}/${b.total})`)
    }
    lines.push(`  Avg outcome score: ${stats.avgOutcomeScore.toFixed(2)} (range -1..1)`)
  }

  if (stats.topReasons.length > 0) {
    lines.push("")
    lines.push("  Top decision reasons:")
    for (const r of stats.topReasons.slice(0, 5)) {
      lines.push(`    ${r.reason.padEnd(25)} ${r.count}`)
    }
  }

  if (stats.subagent.completions > 0) {
    const s = stats.subagent
    lines.push("")
    lines.push("  Subagent isolation:")
    lines.push(`    Spawns: ${s.completions}  · success ${(s.successRate * 100).toFixed(0)}%  · avg ${Math.round(s.avgDurationMs)}ms`)
    lines.push(`    Escalations: ${s.escalationsRequested} (${(s.escalationRate * 100).toFixed(0)}% of spawns)`)
    const intents = Object.entries(s.byIntent).sort((a, b) => b[1] - a[1]).slice(0, 5)
    if (intents.length > 0) {
      lines.push(`    By intent: ${intents.map(([k, v]) => `${k}=${v}`).join(", ")}`)
    }
  }

  return lines.join("\n")
}
