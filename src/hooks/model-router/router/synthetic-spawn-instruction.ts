import type { TaskAnalysis, Tier } from "../types"
import type { SpawnPlan } from "./subagent-decision"
import { buildSubagentPrompt } from "./subagent-prompt-builder"

/**
 * Map our internal router tier to the fork's `Tiering.Tier` enum.
 * The fork's Task tool accepts ("quality" | "balanced" | "budget"
 * | "adaptive" | "inherit"). The router uses ("haiku" | "sonnet"
 * | "opus" | "opus-plan") — opus-plan is virtual and resolves to
 * Opus when spawned (planning phase).
 */
export function tierToForkTier(tier: Tier): "quality" | "balanced" | "budget" {
  if (tier === "opus" || tier === "opus-plan") return "quality"
  if (tier === "sonnet") return "balanced"
  return "budget"
}

/**
 * Pick the subagent_type for the Task tool. The fork ships `general` and
 * `explore` natively. We use `general` for spawn dispatch because explore
 * is read-only (good for research tasks but not implementation).
 *
 * If the user has configured custom subagents and the analysis suggests
 * a specific one (research → explore), we honor that hint.
 */
export function pickSubagentType(analysis: TaskAnalysis): string {
  if (analysis.task_type === "research" || analysis.task_type === "trivial_lookup") return "explore"
  return "general"
}

export interface BuildInstructionInput {
  originalUserMessage: string
  plan: SpawnPlan
  analysis: TaskAnalysis
  parent: {
    sessionID: string
    modelID: string
    providerID: string
    cwd: string
  }
}

/**
 * Build the synthetic text part injected into the user message that tells
 * the main agent to delegate this turn to a subagent via the Task tool.
 *
 * This mirrors the `@agent` invocation pattern already used by the fork
 * (see prompt.ts:1300 — `Use the above message and context to generate a
 * prompt and call the task tool with subagent: <name>`).
 *
 * The instruction is explicit, deterministic, and includes the chosen
 * tier override so the subagent runs with the model the router picked.
 */
export function buildSyntheticSpawnInstruction(input: BuildInstructionInput): string {
  const { plan, analysis } = input
  const subagentType = pickSubagentType(analysis)
  const forkTier = tierToForkTier(plan.tier)

  const subagentPrompt = buildSubagentPrompt(input)

  const intentTag = plan.intent ? ` [intent: ${plan.intent}]` : ""
  const reasoningTag = plan.reasoning !== "none" ? ` [reasoning: ${plan.reasoning}]` : ""

  return [
    "",
    "<router_directive>",
    `The model router classified this turn as: ${plan.label}${intentTag}${reasoningTag}.`,
    `It is being delegated to an isolated subagent so the main session's prompt`,
    `cache stays warm.`,
    "",
    `INVOKE the task tool now with these EXACT parameters (do not rewrite the prompt):`,
    "",
    `  description: ${JSON.stringify(briefDescription(analysis))}`,
    `  subagent_type: ${JSON.stringify(subagentType)}`,
    `  tier: ${JSON.stringify(forkTier)}`,
    `  prompt: |-`,
    indent(subagentPrompt, "    "),
    "",
    `Then return the subagent's <result> verbatim. If the subagent returns an`,
    `<escalation> block, re-invoke the task tool with the SAME prompt but with`,
    `tier set to the escalation target (current=${forkTier} → escalate=${escalationForkTier(plan)})`,
    `and add a brief note that this is an escalation retry.`,
    "</router_directive>",
  ].join("\n")
}

function briefDescription(a: TaskAnalysis): string {
  const tt = a.task_type.replace(/_/g, " ")
  return tt.length > 40 ? tt.slice(0, 40) : tt
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join("\n")
}

function escalationForkTier(plan: SpawnPlan): string {
  if (!plan.escalation_target) return tierToForkTier(plan.tier)
  return tierToForkTier(plan.escalation_target)
}
