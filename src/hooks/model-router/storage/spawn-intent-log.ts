import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { SpawnPlan } from "../router/subagent-decision"
import type { RoutingDecision, Tier } from "../types"

/**
 * Append-only JSONL log of spawn intents. Captures the plan the router
 * would have spawned, the generated subagent prompt, and (when the spawn
 * eventually runs) its outcome. This is the primary observability surface
 * for the subagent isolation feature in shadow mode.
 */

export interface SpawnIntentRecord {
  version: 1
  timestamp: number
  sessionID: string
  turnNumber: number
  parentAgent: string
  parentModel: { providerID: string; modelID: string }
  plan: SpawnPlan
  decisionTier: Tier
  decisionReasons: string[]
  analysisSummary: {
    task_type: string
    scope_breadth: string
    risk_level: string
    iteration_profile: string
    detected_intent: string | null | undefined
    subagent_suitable: boolean | undefined
    complexity_uncertainty: string | undefined
    confidence: number
  }
  subagentPromptPreview: string // first 500 chars of the generated prompt
  subagentPromptSha256: string // full hash for correlation
  mode: "shadow" | "spawn"
  /** Populated when mode=spawn and the subagent completes. */
  outcome?: SpawnOutcome
}

export interface SpawnOutcome {
  type: "result" | "error" | "escalation" | "fallthrough"
  completedAt: number
  durationMs: number
  escalatedTo?: Tier
  escalationChain?: Tier[]
  deliverablePreview?: string
  errorReason?: string
  subagentSessionID?: string
}

export function defaultSpawnLogPath(base?: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp"
  const baseDir = base ?? path.join(home, ".local", "share", "meridian")
  return path.join(baseDir, "routing-spawn-intents.jsonl")
}

export async function appendSpawnIntent(logPath: string, record: SpawnIntentRecord): Promise<void> {
  try {
    await mkdir(path.dirname(logPath), { recursive: true })
    await appendFile(logPath, JSON.stringify(record) + "\n", "utf8")
  } catch (e) {
    // Never let observability break the hot path.
    // eslint-disable-next-line no-console
    console.warn("[model-router] failed to append spawn intent:", e)
  }
}

export async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function summarizeAnalysis(decision: RoutingDecision): SpawnIntentRecord["analysisSummary"] {
  const a = decision.analysis
  return {
    task_type: a?.task_type ?? "unknown",
    scope_breadth: a?.scope_breadth ?? "unknown",
    risk_level: a?.risk_level ?? "unknown",
    iteration_profile: a?.iteration_profile ?? "unknown",
    detected_intent: a?.detected_intent ?? null,
    subagent_suitable: a?.subagent_suitable,
    complexity_uncertainty: a?.complexity_uncertainty,
    confidence: decision.confidence,
  }
}
