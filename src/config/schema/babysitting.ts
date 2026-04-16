import { z } from "zod"

/**
 * Stall escalation — when the babysitter's reminder injection does not
 * revive a stuck subagent task, escalate by aborting it and notifying
 * the user via toast. Prevents tasks from staying "reminded but still
 * pending" indefinitely.
 */
export const StallEscalationConfigSchema = z.object({
  /** Enable stall escalation. Default: true. */
  enabled: z.boolean().default(true),
  /**
   * How long to wait after reminder injection before aborting the task.
   * Default: 180000 (3 minutes). Minimum: 30000 (30s).
   *
   * If the subagent produces ANY message or tool activity in this window,
   * the escalation is cancelled. Only tasks that stay fully silent after
   * the reminder are aborted.
   */
  abortAfterMs: z.number().min(30000).default(180000),
  /**
   * Show a toast notification when a task is aborted due to stall.
   * Default: true.
   */
  notify: z.boolean().default(true),
})

export type StallEscalationConfig = z.infer<typeof StallEscalationConfigSchema>

export const BabysittingConfigSchema = z.object({
  timeout_ms: z.number().default(120000),
  stallEscalation: StallEscalationConfigSchema.optional(),
})

export type BabysittingConfig = z.infer<typeof BabysittingConfigSchema>
