import type { Tier } from "../types"
import { parseSubagentOutput, shouldHonorEscalation } from "./escalation"
import { tierToForkTier } from "./synthetic-spawn-instruction"

/**
 * Escalation loop helpers — used by the feedback loop / event handler to
 * detect that a subagent emitted an <escalation> block in its task tool
 * result and to decide whether to instruct the main agent to retry with
 * an upgraded tier.
 *
 * The heavy lifting (parsing + tier policy) lives in escalation.ts.
 * This module wires the policy into the multi-turn lifecycle.
 */

export interface DetectedEscalation {
  detected: true
  honor: boolean
  fromTier: Tier
  toTier: Tier
  reason: string
  retryInstruction: string
  evidence: string
}

export interface NoEscalation {
  detected: false
}

export type EscalationDetection = DetectedEscalation | NoEscalation

export interface DetectArgs {
  subagentOutput: string
  currentTier: Tier
  previousEscalations: number
}

export function detectEscalation(args: DetectArgs): EscalationDetection {
  const parsed = parseSubagentOutput(args.subagentOutput)
  if (parsed.signal?.type !== "escalation") return { detected: false }

  const policy = shouldHonorEscalation({
    current: args.currentTier,
    requested: parsed.signal.target_tier,
    previousEscalations: args.previousEscalations,
  })

  return {
    detected: true,
    honor: policy.honor,
    fromTier: args.currentTier,
    toTier: parsed.signal.target_tier,
    reason: parsed.signal.reason,
    retryInstruction: buildEscalationRetryInstruction({
      target: parsed.signal.target_tier,
      reason: parsed.signal.reason,
      condensed: parsed.signal.condensed_context,
      evidence: parsed.signal.evidence,
    }),
    evidence: parsed.signal.evidence,
  }
}

interface RetryInput {
  target: Tier
  reason: string
  condensed: string
  evidence: string
}

/**
 * Build a synthetic retry instruction the main agent can use when the
 * subagent escalates. The main re-invokes the task tool with:
 *   - same description (with [escalated] suffix)
 *   - same subagent_type
 *   - tier upgraded to the escalation target
 *   - prompt augmented with the condensed context from the prior subagent
 */
export function buildEscalationRetryInstruction(input: RetryInput): string {
  return [
    "",
    "<router_escalation_retry>",
    `The previous subagent escalated. Reason: ${input.reason}`,
    `Re-invoke the task tool NOW with the SAME prompt body, but:`,
    `  - tier: ${JSON.stringify(tierToForkTier(input.target))}`,
    `  - description: append "(escalation retry)" to the prior description`,
    `  - prepend this to the prompt's <original_user_request> block:`,
    `      <prior_attempt_evidence>`,
    `      ${input.evidence}`,
    `      </prior_attempt_evidence>`,
    `      <prior_attempt_context>`,
    `      ${input.condensed}`,
    `      </prior_attempt_context>`,
    `</router_escalation_retry>`,
  ].join("\n")
}

export { tierToForkTier }
