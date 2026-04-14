import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder";
import type { ContextCollector } from "../../features/context-injector/collector";
import { log } from "../../shared";
import * as loaded from "../shared/loaded-skill-tracker";
import * as tracker from "../shared/domain-tracker";
import { matchSkills } from "../shared/skill-suggestion-matcher";

function buildContent(skills: AvailableSkill[], domain: string): string {
  const names = skills
    .map((s) => `- \`${s.name}\`: ${s.description.slice(0, 80)}`)
    .join("\n");
  return [
    `[Skill Reload — post-compaction, previous domain: ${domain}]`,
    "Skills relevant to the work before compaction:",
    names,
    "",
    `Load with: skill(name="${skills[0].name}")`,
  ].join("\n");
}

export function createSkillCompactionReloaderHook(
  skills: AvailableSkill[],
  collector: ContextCollector,
) {
  const event = async ({
    event,
  }: {
    event: { type: string; properties?: unknown };
  }) => {
    if (event.type !== "session.compacted") return;

    const props = event.properties as Record<string, unknown> | undefined;
    const sessionID = (props?.sessionID ??
      (props?.info as { id?: string } | undefined)?.id) as string | undefined;
    if (!sessionID) return;

    const domain = tracker.current(sessionID);
    if (!domain || domain === "unknown") return;

    const keywords = tracker.DOMAIN_KEYWORDS[domain];
    const matched = matchSkills(keywords, skills, 5).filter(
      (sk) => !loaded.isLoaded(sessionID, sk.name),
    );
    if (matched.length === 0) return;

    collector.register(sessionID, {
      id: "skill-compaction-reload",
      source: "custom",
      content: buildContent(matched, domain),
      priority: "normal",
    });

    log("[skill-compaction-reloader] Registered skill reload context", {
      sessionID,
      domain,
      skills: matched.map((s) => s.name),
    });
  };

  return { event };
}
