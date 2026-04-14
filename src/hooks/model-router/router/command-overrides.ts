/**
 * Slash command detection and context enrichment.
 *
 * Custom commands expand into generic template text that gives the
 * analyzer no signal. Instead of forcing a tier, we:
 *   1. Detect which command is being invoked
 *   2. Provide workflow context so the analyzer (or rules) knows
 *      the inherent complexity RANGE of the command
 *   3. For commands where the ARGUMENTS carry the complexity signal
 *      (e.g., /resolve-task <task-url>), we extract and forward them
 *   4. For commands with inherently fixed complexity (e.g., /merge-complete
 *      is always mechanical), we CAN force a tier
 *
 * This is NOT an override map — it's a context enricher. The analyzer
 * still decides; it just gets better input.
 */

import type { Tier } from "../types"

export interface CommandContext {
  /** Detected command name. */
  name: string
  /** Brief description of the workflow for analyzer context. */
  workflowDescription: string
  /**
   * Complexity profile of the command:
   *   - "variable" → complexity depends on the arguments; let analyzer decide
   *   - "always_high" → inherently complex (e.g., architectural redesign tool)
   *   - "always_low" → inherently simple (e.g., merge + cleanup)
   */
  complexityProfile: "variable" | "always_high" | "always_low"
  /** If complexity is NOT variable, force this tier. */
  forcedTier?: Tier
  /** Extracted arguments from the template (e.g., the ClickUp URL). */
  extractedArgs?: string
}

interface CommandPattern {
  pattern: RegExp
  name: string
  workflowDescription: string
  complexityProfile: "variable" | "always_high" | "always_low"
  forcedTier?: Tier
  /** Regex to extract the user's actual argument from $ARGUMENTS expansion. */
  argsExtractor?: RegExp
}

const COMMAND_PATTERNS: CommandPattern[] = [
  {
    // /resolve-task — full lifecycle; complexity depends on what the task asks
    pattern: /user-commands\/resolve-task\.md/i,
    name: "resolve-task",
    workflowDescription:
      "End-to-end ClickUp task resolution: analyze task → plan → create worktree → implement with TDD → test → commit → update ClickUp. Complexity depends on the task itself — can range from a simple typo fix to a multi-file refactor.",
    complexityProfile: "variable",
    argsExtractor: /user's ClickUp task to resolve:\s*(.+?)(?:\s*$)/is,
  },
  {
    // /senior-review — deep review; inherently complex (8+ quality lenses)
    pattern: /user-commands\/senior-review\.md/i,
    name: "senior-review",
    workflowDescription:
      "Deep senior-level code review across 8 quality lenses: design alternatives, code reuse, coupling, security, performance, accessibility, DX, and test coverage. Always requires deep reasoning.",
    complexityProfile: "always_high",
    forcedTier: "opus",
  },
  {
    // /merge-complete — mechanical merge + cleanup
    pattern: /user-commands\/merge-complete\.md/i,
    name: "merge-complete",
    workflowDescription:
      "Merge feature branch, update ClickUp task status, cleanup worktree. Mostly mechanical git operations.",
    complexityProfile: "always_low",
    forcedTier: "sonnet",
  },
]

/**
 * Detect if the prompt is an expanded slash command template.
 * Returns enriched context, or null if not a command.
 */
export function detectCommand(promptText: string): CommandContext | null {
  for (const cmd of COMMAND_PATTERNS) {
    if (!cmd.pattern.test(promptText)) continue

    let extractedArgs: string | undefined
    if (cmd.argsExtractor) {
      const match = cmd.argsExtractor.exec(promptText)
      if (match?.[1]) {
        extractedArgs = match[1].trim()
      }
    }

    return {
      name: cmd.name,
      workflowDescription: cmd.workflowDescription,
      complexityProfile: cmd.complexityProfile,
      forcedTier: cmd.forcedTier,
      extractedArgs,
    }
  }
  return null
}

/**
 * Build an enriched prompt for the analyzer when a command is detected.
 * Combines the workflow description with the user's arguments so the
 * analyzer can assess the actual complexity.
 */
export function enrichPromptForAnalyzer(
  originalPrompt: string,
  command: CommandContext,
): string {
  if (command.complexityProfile !== "variable") {
    // No enrichment needed — tier is forced
    return originalPrompt
  }

  const parts = [
    `[COMMAND CONTEXT] This is a /${command.name} workflow invocation.`,
    `Workflow: ${command.workflowDescription}`,
  ]

  if (command.extractedArgs) {
    parts.push(`User's actual input: ${command.extractedArgs}`)
    parts.push(
      `Analyze the COMPLEXITY of the user's input to determine which model tier is appropriate. A simple task (typo fix, rename) should use a lighter model; a complex task (multi-file refactor, new feature with tests) should use a stronger model.`,
    )
  } else {
    parts.push(
      `No specific task arguments provided. Assess the general complexity of this workflow type.`,
    )
  }

  return parts.join("\n")
}
