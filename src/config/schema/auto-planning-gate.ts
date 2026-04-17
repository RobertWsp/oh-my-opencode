import { z } from "zod"

/**
 * Configuration for the auto-planning-gate hook.
 *
 * On the first user message of a session, invokes the model-router's
 * analyzer (Sonnet 4.6 by default) to classify the task. When the
 * classification indicates planning is warranted (architectural,
 * complex_refactor, or risky standard_implementation), programmatically
 * injects a directive to invoke Prometheus before execution.
 */
export const AutoPlanningGateConfigSchema = z.object({
  /** Enable the gate. Default: true. */
  enabled: z.boolean().default(true),
  /**
   * Model ID for the analyzer call. Default: claude-sonnet-4-6.
   * Haiku is faster/cheaper but may misclassify edge cases; Sonnet is
   * the recommended balance.
   */
  analyzerModelID: z.string().default("claude-sonnet-4-6"),
  /** Timeout in ms for the analyzer call. Default: 20000, min: 5000. */
  timeoutMs: z.number().int().min(5000).default(20_000),
  /**
   * Agents for which the gate is skipped. Use when a specific agent
   * already handles planning itself (e.g. prometheus, momus).
   * Default: empty array (gate runs for any primary agent).
   */
  disabledAgents: z.array(z.string()).default([]),
})

export type AutoPlanningGateConfig = z.infer<typeof AutoPlanningGateConfigSchema>
