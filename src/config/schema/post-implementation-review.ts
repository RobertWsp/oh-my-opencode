import { z } from "zod"

/**
 * Configuration for the post-implementation-review hook.
 *
 * When a task with `subagent_type` matching `reviewableAgents`
 * completes and produces substantial output, this hook injects a Momus
 * review directive into the parent session. The primary agent then
 * executes the review → fix loop via session_id before marking the
 * task done.
 */
export const PostImplementationReviewConfigSchema = z.object({
  /** Enable the hook. Default: true. */
  enabled: z.boolean().default(true),
  /**
   * Subagent types whose completion triggers Momus review.
   * Default: ["hephaestus"].
   *
   * To also review Atlas or other implementers, add them here.
   */
  reviewableAgents: z.array(z.string()).default(["hephaestus"]),
  /**
   * Minimum output length (chars) to trigger review. Below this
   * threshold the output is treated as trivial/acknowledgement and
   * the review is skipped. Default: 400.
   */
  minOutputChars: z.number().int().min(50).default(400),
  /**
   * Per-session cooldown between reviews (ms). Prevents review spam
   * when Sisyphus chains implementers rapidly. Default: 60000 (60s).
   */
  cooldownMs: z.number().int().min(5000).default(60_000),
})

export type PostImplementationReviewConfig = z.infer<typeof PostImplementationReviewConfigSchema>
