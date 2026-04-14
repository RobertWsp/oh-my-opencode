import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder";
import { getSessionAgent } from "../../features/claude-code-session-state";
import { log } from "../../shared";
import { getAgentConfigKey } from "../../shared/agent-display-names";
import * as gate from "../shared/skill-suggestion-gate";
import * as tracker from "../shared/loaded-skill-tracker";
import { matchSkills } from "../shared/skill-suggestion-matcher";
import { classify, hasError } from "./error-classifier";
import { buildMessage } from "./formatter";

const TARGET_AGENTS = new Set(["sisyphus", "sisyphus-junior", "atlas"]);

const COOLDOWN = 5;

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

interface SessionState {
  lastSuggestion: number;
  callsSinceSuggestion: number;
}

export function createSkillErrorReactorHook(skills: AvailableSkill[]) {
  const states = new Map<string, SessionState>();

  function state(sessionID: string): SessionState {
    if (!states.has(sessionID)) {
      states.set(sessionID, {
        lastSuggestion: 0,
        callsSinceSuggestion: COOLDOWN,
      });
    }
    return states.get(sessionID)!;
  }

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
    const { sessionID } = input;
    if (!isTarget(sessionID, input.agent)) return;

    const s = state(sessionID);
    s.callsSinceSuggestion++;

    if (!hasError(output.output, output.metadata)) return;
    if (s.callsSinceSuggestion < COOLDOWN) return;

    const classified = classify(output.output);
    if (!classified) return;

    const matched = matchSkills(classified.keywords, skills).filter(
      (sk) => !tracker.isLoaded(sessionID, sk.name),
    );
    if (matched.length === 0) return;

    if (!gate.acquire(sessionID, "skill-error-reactor")) return;

    const msg = buildMessage(classified.category, matched);
    if (!msg) return;

    output.output += msg;
    s.callsSinceSuggestion = 0;
    s.lastSuggestion = Date.now();

    log("[skill-error-reactor] Suggested skills", {
      sessionID,
      category: classified.category,
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
      if (id) states.delete(id);
    }
  };

  return { "tool.execute.after": handler, event };
}
