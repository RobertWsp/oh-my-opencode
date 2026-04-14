import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder";
import { getSessionAgent } from "../../features/claude-code-session-state";
import { log } from "../../shared";
import { getAgentConfigKey } from "../../shared/agent-display-names";
import * as gate from "../shared/skill-suggestion-gate";
import * as loaded from "../shared/loaded-skill-tracker";
import * as tracker from "../shared/domain-tracker";
import { matchSkills } from "../shared/skill-suggestion-matcher";
import { buildMessage } from "./formatter";

const TARGET_AGENTS = new Set(["sisyphus", "sisyphus-junior", "atlas"]);

interface ToolInput {
  tool: string;
  sessionID: string;
  callID: string;
  agent?: string;
}

interface ToolOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

export function createSkillDomainDetectorHook(skills: AvailableSkill[]) {
  function isTarget(sessionID: string, agent?: string): boolean {
    const resolved = getSessionAgent(sessionID) ?? agent;
    if (!resolved) return false;
    const key = getAgentConfigKey(resolved);
    return (
      TARGET_AGENTS.has(key) ||
      key.includes("sisyphus") ||
      key.includes("atlas")
    );
  }

  const handler = async (input: ToolInput, output: ToolOutput) => {
    const { tool, sessionID } = input;
    if (!isTarget(sessionID, input.agent)) return;

    const path = tracker.extractPath(output.output, tool.toLowerCase());
    if (!path) return;

    const ext = tracker.extractExt(path);
    if (!ext) return;

    const domain = tracker.toDomain(ext);
    if (domain === "unknown") return;

    const shifted = tracker.update(sessionID, domain);
    if (!shifted) return;

    const keywords = tracker.DOMAIN_KEYWORDS[domain];
    const matched = matchSkills(keywords, skills).filter(
      (sk) => !loaded.isLoaded(sessionID, sk.name),
    );
    if (matched.length === 0) return;

    if (!gate.acquire(sessionID, "skill-domain-detector")) return;

    const msg = buildMessage(domain, matched);
    if (!msg) return;

    output.output += msg;
    log("[skill-domain-detector] Domain shift detected", {
      sessionID,
      domain,
      skills: matched.map((sk) => sk.name),
    });
  };

  const event = async ({
    event,
  }: {
    event: { type: string; properties?: unknown };
  }) => {
    const props = event.properties as Record<string, unknown> | undefined;
    if (
      event.type === "session.deleted" ||
      event.type === "session.compacted"
    ) {
      const id = (props?.sessionID ??
        (props?.info as { id?: string } | undefined)?.id) as string | undefined;
      if (id) tracker.clear(id);
    }
  };

  return { "tool.execute.after": handler, event };
}
