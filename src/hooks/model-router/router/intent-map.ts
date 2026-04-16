import type { DetectedIntent, ReasoningDepth, TaskAnalysis, Tier } from "../types"

/**
 * Direct intent → dispatch defaults. When `detected_intent` is set on the
 * analysis (and is not "none"), these take precedence over the generic
 * decision-matrix rules.
 *
 * Design principle: user-stated operational intents (commit, merge, etc.)
 * carry enough signal on their own to pick a tier without running the full
 * 9-dimension decision matrix. The matrix stays as fallback.
 */
export interface IntentDispatch {
  tier: Tier
  reasoning: ReasoningDepth
  /**
   * Should the router spawn an isolated subagent rather than swap the main
   * session's model? Spawning preserves the main session's prompt cache.
   */
  prefer_subagent: boolean
  /**
   * Enable escalation callback — subagent can request upgrade mid-run if
   * complexity surfaces (e.g. merge has conflicts after all).
   */
  allow_escalation: boolean
  /**
   * If escalation triggers, what tier to upgrade to.
   */
  escalation_target?: Tier
  /**
   * Short, human-readable label for logs/UI.
   */
  label: string
}

export const INTENT_MAP: Record<Exclude<DetectedIntent, null>, IntentDispatch> = {
  commit_push: {
    tier: "haiku",
    reasoning: "none",
    prefer_subagent: true,
    allow_escalation: false,
    label: "commit+push (mechanical git ops)",
  },
  merge_simple: {
    tier: "haiku",
    reasoning: "shallow",
    prefer_subagent: true,
    allow_escalation: true,
    escalation_target: "sonnet",
    label: "merge simple (≤2 files, no conflicts)",
  },
  merge_complex: {
    tier: "sonnet",
    reasoning: "medium",
    prefer_subagent: true,
    allow_escalation: true,
    escalation_target: "opus",
    label: "merge complex (conflicts / many files)",
  },
  refactor_architectural: {
    tier: "opus-plan" as Tier,
    reasoning: "deep",
    prefer_subagent: false, // Architect pattern in main session
    allow_escalation: false,
    label: "architectural refactor (opus-plan in main session)",
  },
  security_audit: {
    tier: "opus",
    reasoning: "deep",
    prefer_subagent: true,
    allow_escalation: false,
    label: "security audit (specialized Opus)",
  },
  bug_investigation: {
    tier: "sonnet",
    reasoning: "medium",
    prefer_subagent: true,
    allow_escalation: true,
    escalation_target: "opus",
    label: "bug investigation (escalate to Opus on dead-ends)",
  },
  docs_update: {
    tier: "haiku",
    reasoning: "shallow",
    prefer_subagent: true,
    allow_escalation: false,
    label: "docs update (prose only)",
  },
  test_write: {
    tier: "sonnet",
    reasoning: "medium",
    prefer_subagent: true,
    allow_escalation: false,
    label: "test authoring",
  },
  lookup_qa: {
    tier: "haiku",
    reasoning: "none",
    prefer_subagent: false, // QA lives in main dialog
    allow_escalation: false,
    label: "lookup / Q&A",
  },
}

/**
 * Resolve intent from the analysis. Returns the dispatch or null if no
 * mapping applies (detected_intent is "none" or absent).
 */
export function resolveIntentDispatch(a: TaskAnalysis): IntentDispatch | null {
  const intent = a.detected_intent
  if (!intent || (intent as string) === "none") return null
  return INTENT_MAP[intent] ?? null
}
