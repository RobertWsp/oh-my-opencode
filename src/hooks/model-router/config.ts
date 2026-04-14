import { z } from "zod"

/**
 * Model router configuration, loaded from
 * ~/.config/opencode/oh-my-opencode.jsonc under key `model_router`.
 */
export const ModelRouterConfigSchema = z.object({
  /** Master toggle. Default: false (opt-in). */
  enabled: z.boolean().default(false),

  /**
   * Strategy:
   *   - "hybrid"        — analyzer (Sonnet) + rules fallback. Default.
   *   - "rules_only"    — no LLM analyzer, deterministic rules only.
   *   - "analyzer_only" — analyzer required; error if it fails.
   */
  strategy: z.enum(["hybrid", "rules_only", "analyzer_only"]).default("hybrid"),

  /**
   * Haiku pre-screen (Camada 4) — cheap first-pass classifier that
   * short-circuits the decision when Haiku is confident (≥0.85) the task
   * is trivially haiku or sonnet. Cuts analyzer calls ~70% in mixed
   * workloads. Disable only if you want to guarantee every decision goes
   * through the full Sonnet analyzer.
   */
  preScreen: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default(() => ({ enabled: true })),

  analyzer: z
    .object({
      /** Provider ID for analyzer model. */
      providerID: z.string().default("anthropic"),
      /**
       * Model ID for analyzer. Sonnet 4.6 is default — user prefers
       * precision over speed for the classification step. The rules
       * fallback exists only for analyzer failures (timeout / rate limit /
       * credentials missing). If you see rules_* decisions frequently,
       * check logs: the analyzer should be the dominant path.
       */
      modelID: z.string().default("claude-sonnet-4-6"),
      /** Timeout before falling back to rules (ms). Default 20s to
       * accommodate Meridian's first-call SDK subprocess cold start. */
      timeoutMs: z.number().int().positive().default(20_000),
      /** Cache TTL for decision hash (ms). */
      cacheTtlMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
    })
    .default(() => ({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      timeoutMs: 20_000,
      cacheTtlMs: 24 * 60 * 60 * 1000,
    })),

  /** Jaccard threshold below which we re-analyze in multi-turn (0-1). */
  reanalyzeJaccardThreshold: z.number().min(0).max(1).default(0.2),

  /** Per-agent tier forcing. Empty object = use defaults from constants. */
  agentOverrides: z.record(z.string(), z.enum(["haiku", "sonnet", "opus", "opus-plan"])).default({}),

  /** Emit routing decisions to JSONL log. */
  logDecisions: z.boolean().default(true),

  /** Log file path. Default uses Meridian's data dir. */
  logPath: z.string().optional(),

  /** Show decision in TUI status line. */
  statusLine: z.boolean().default(true),

  /** Enable the feedback loop. */
  feedbackLoop: z.boolean().default(true),
})

export type ModelRouterConfig = z.infer<typeof ModelRouterConfigSchema>

/**
 * Parse `model_router` config section with defaults.
 * Accepts `undefined`, `true`, `false`, or an object.
 */
export function parseModelRouterConfig(raw: unknown): ModelRouterConfig {
  if (raw === undefined || raw === null) {
    return ModelRouterConfigSchema.parse({ enabled: false })
  }
  if (raw === true) {
    return ModelRouterConfigSchema.parse({ enabled: true })
  }
  if (raw === false) {
    return ModelRouterConfigSchema.parse({ enabled: false })
  }
  return ModelRouterConfigSchema.parse(raw)
}
