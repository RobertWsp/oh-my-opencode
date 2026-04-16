import type { TaskAnalysis, Tier } from "../types"
import type { SpawnPlan } from "./subagent-decision"

/**
 * Build the prompt that goes to an isolated subagent.
 *
 * Design principles:
 *  - Subagent starts with a FRESH context (no parent history). The prompt
 *    must contain every piece of information the subagent needs.
 *  - Keep the user's original intent verbatim — wrap it, don't rewrite it.
 *  - Instruct the subagent on HOW to report back so the parent can parse:
 *      <result>…</result>    successful output
 *      <escalation>…</escalation>   request for more capable model
 *      <error>…</error>      hard failure with recovery hint
 *  - Make the escalation contract explicit: what triggers it, what to include.
 */

export interface BuildSubagentPromptInput {
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

export function buildSubagentPrompt(input: BuildSubagentPromptInput): string {
  const { originalUserMessage, plan, analysis, parent } = input
  const sections: string[] = []

  sections.push(
    [
      "<subagent_brief>",
      `You are a Claude subagent spawned by an orchestrator to complete a self-contained task.`,
      `Your result is returned verbatim to the parent session as a tool_result — the parent's`,
      `cache is isolated from yours and will NOT see your intermediate reasoning. Be direct.`,
      "</subagent_brief>",
    ].join("\n"),
  )

  sections.push(
    [
      "<task_profile>",
      `Type: ${analysis.task_type}`,
      `Reasoning depth: ${analysis.reasoning_depth}`,
      `Scope: ${analysis.scope_breadth}${
        analysis.estimated_files_touched ? ` (≈${analysis.estimated_files_touched} files)` : ""
      }`,
      `Risk: ${analysis.risk_level}`,
      `Iteration: ${analysis.iteration_profile}`,
      `Assigned tier: ${plan.tier}`,
      `Reasoning budget: ${plan.reasoning}`,
      plan.intent ? `Matched intent: ${plan.intent}` : null,
      `Label: ${plan.label}`,
      "</task_profile>",
    ]
      .filter(Boolean)
      .join("\n"),
  )

  sections.push(
    [
      "<parent_context>",
      `Parent session: ${parent.sessionID}`,
      `Parent model: ${parent.providerID}/${parent.modelID}`,
      `Working directory: ${parent.cwd}`,
      `Parent did NOT pass its history — assume you have none unless stated below.`,
      "</parent_context>",
    ].join("\n"),
  )

  if (plan.allow_escalation) {
    sections.push(buildEscalationContract(plan))
  }

  sections.push(buildOutputContract())

  sections.push(
    [
      "<original_user_request>",
      originalUserMessage.trim(),
      "</original_user_request>",
    ].join("\n"),
  )

  sections.push(
    "Complete the task now. Wrap your deliverable in <result>…</result> as described. Do not narrate the protocol.",
  )

  return sections.join("\n\n")
}

function buildEscalationContract(plan: SpawnPlan): string {
  const target = plan.escalation_target ?? higherTier(plan.tier)
  return [
    "<escalation_protocol>",
    `You may request a more capable model mid-task by emitting an <escalation> block and`,
    `stopping. The parent will re-spawn this task with: tier=${target}.`,
    `Trigger escalation when ANY of:`,
    `  - You discover significantly more complexity than the profile estimates`,
    `  - You hit ≥2 consecutive tool failures with the same approach`,
    `  - The user's intent is materially ambiguous after inspecting the code`,
    `  - Completing correctly would require deep reasoning beyond your budget`,
    ``,
    `Escalation format (emit ONLY this, stop after):`,
    `<escalation>`,
    `reason: <one sentence — what forced the escalation>`,
    `target_tier: ${target}`,
    `evidence: <what you found that invalidated the original estimate>`,
    `condensed_context: <≤500 words summarizing files read, decisions made, open questions>`,
    `</escalation>`,
    "</escalation_protocol>",
  ].join("\n")
}

function buildOutputContract(): string {
  return [
    "<output_contract>",
    "On success, wrap the final deliverable in:",
    "  <result>",
    "  <your deliverable here — code diff summary, answer, or completion report>",
    "  </result>",
    "",
    "On unrecoverable failure:",
    "  <error>",
    "  reason: <what failed>",
    "  recovery_hint: <what the parent could try>",
    "  </error>",
    "</output_contract>",
  ].join("\n")
}

function higherTier(tier: Tier): Tier {
  if (tier === "haiku") return "sonnet"
  if (tier === "sonnet") return "opus"
  return tier
}
