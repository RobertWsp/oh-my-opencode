import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder";
import type { Domain } from "../shared/domain-tracker";

function formatNames(skills: AvailableSkill[]): string {
  return skills.map((s) => `\`${s.name}\``).join(", ");
}

export function buildMessage(domain: Domain, skills: AvailableSkill[]): string {
  if (skills.length === 0) return "";

  const example = skills[0].name;
  return [
    "",
    `[Skill Suggestion — domain shift to ${domain}]`,
    `Relevant skills: ${formatNames(skills)}`,
    `Load with: skill(name="${example}")`,
    "",
  ].join("\n");
}
