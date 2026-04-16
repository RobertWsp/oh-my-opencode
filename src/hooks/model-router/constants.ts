/**
 * Model Router — constants.
 */

import type { Tier } from "./types"

/**
 * Canonical Claude model IDs by tier.
 * opus-plan is a virtual tier resolved at runtime to opus or sonnet
 * depending on plan-phase state.
 */
export const MODEL_IDS: Record<Exclude<Tier, "opus-plan">, { providerID: string; modelID: string }> = {
  haiku: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  sonnet: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  opus: { providerID: "anthropic", modelID: "claude-opus-4-7" },
}

/**
 * Analyzer runs on Sonnet 4.6 for precision. User prefers accuracy over
 * the ~500ms latency delta vs Haiku.
 */
export const ANALYZER_MODEL = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-6",
}

/**
 * Max time to wait for the analyzer before falling back to rules.
 * 20s accommodates Meridian's first-call subprocess cold start. Subsequent
 * calls are faster once Meridian has a warm SDK subprocess.
 */
export const ANALYZER_TIMEOUT_MS = 20_000

/**
 * Decision cache TTL — how long to keep a cached decision for the same
 * prompt hash.
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * Maximum decision cache size (LRU).
 */
export const CACHE_MAX_ENTRIES = 500

/**
 * Multi-turn: if the new prompt is this different from the previous one
 * (Jaccard word overlap), re-analyze.
 */
export const REANALYZE_JACCARD_THRESHOLD = 0.2

/**
 * Phrase markers that signal a context shift and force re-analysis.
 */
export const SHIFT_MARKERS = [
  "agora vamos",
  "mudei de ideia",
  "na verdade",
  "esquece",
  "deixa pra la",
  "outro assunto",
  "now let's",
  "nevermind",
  "scratch that",
  "forget it",
  "different topic",
]

/**
 * Paths for persisted data.
 */
export const ROUTING_LOG_PATH = "/home/robert/.local/share/meridian/routing-decisions.jsonl"
export const FEEDBACK_LOG_DIR = "/home/robert/.local/share/meridian/feedback"

/**
 * Agent → forced tier. Only agents that ALWAYS need a specific tier.
 *
 * IMPORTANT: Sisyphus (the default "all"-mode agent in oh-my-opencode)
 * is intentionally NOT in this map because ALL prompts arrive as
 * "Sisyphus (Ultraworker)" even when the user is doing trivial tasks.
 * Pinning sisyphus to opus would bypass the analyzer for 100% of
 * requests, defeating the entire purpose of the router.
 *
 * Agents in this map are ones the user explicitly invokes for a specific
 * purpose (e.g., /oracle for strategic advice) — their intent is clear.
 */
export const AGENT_TIER_OVERRIDES: Record<string, Tier> = {
  // Strategic/reasoning agents — Opus (user explicitly chose these)
  oracle: "opus",
  prometheus: "opus",
  metis: "opus",
  momus: "opus",

  // Implementation agents — Sonnet
  atlas: "sonnet",
  hephaestus: "sonnet",
  "sisyphus-junior": "sonnet",

  // IO/lookup agents — Haiku
  librarian: "haiku",
  explore: "haiku",
  "multimodal-looker": "haiku",

  // Internal Claude Code agents — Haiku (they're cheap meta-tasks)
  title: "haiku",
  summary: "haiku",
  compaction: "haiku",
}
