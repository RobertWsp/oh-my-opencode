import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder";
import type { ErrorCategory } from "./error-classifier";

function formatNames(skills: AvailableSkill[]): string {
  return skills.map((s) => `\`${s.name}\``).join(", ");
}

export function buildMessage(
  category: ErrorCategory,
  skills: AvailableSkill[],
): string {
  if (skills.length === 0) return "";

  const example = skills[0].name;
  return [
    "",
    `[Skill Suggestion — ${category} error detected]`,
    `Relevant skills: ${formatNames(skills)}`,
    `Load with: skill(name="${example}")`,
    "",
  ].join("\n");
}
