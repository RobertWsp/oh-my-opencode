import { describe, expect, test, beforeEach, mock } from "bun:test";
import { createSkillDomainDetectorHook } from "./hook";
import * as tracker from "../shared/domain-tracker";
import * as gate from "../shared/skill-suggestion-gate";

mock.module("../../features/claude-code-session-state", () => ({
  getSessionAgent: (id: string) =>
    id === "sis-session" ? "sisyphus" : undefined,
}));

mock.module("../../shared/agent-display-names", () => ({
  getAgentConfigKey: (name: string) => name.toLowerCase(),
}));

mock.module("../../shared", () => ({
  log: () => {},
}));

const SKILLS = [
  {
    name: "software-frontend",
    description: "Production frontend React Next.js component",
    location: "user" as const,
  },
  {
    name: "ruff-dev",
    description: "Python linter formatter ruff",
    location: "user" as const,
  },
  {
    name: "vitest-testing",
    description: "TypeScript JavaScript testing Vitest",
    location: "user" as const,
  },
  {
    name: "devops-engineer",
    description: "Docker kubernetes CI CD infrastructure",
    location: "user" as const,
  },
];

describe("createSkillDomainDetectorHook", () => {
  beforeEach(() => {
    tracker.clear("sis-session");
    gate.reset("sis-session");
  });

  test("does not trigger for non-path tools", async () => {
    const hook = createSkillDomainDetectorHook(SKILLS);
    const output = { title: "", output: "ok", metadata: {} };
    await hook["tool.execute.after"](
      { tool: "task", sessionID: "sis-session", callID: "1" },
      output,
    );
    expect(output.output).toBe("ok");
  });

  test("does not trigger for non-target agents", async () => {
    const hook = createSkillDomainDetectorHook(SKILLS);
    const output = {
      title: "",
      output: "  /src/app.tsx\ncontent",
      metadata: {},
    };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "other-session", callID: "1" },
      output,
    );
    expect(output.output).not.toContain("[Skill Suggestion");
  });

  test("does not trigger on first domain (no shift yet)", async () => {
    const hook = createSkillDomainDetectorHook(SKILLS);
    const output = {
      title: "",
      output: "  /src/app.tsx\ncontent",
      metadata: {},
    };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "1" },
      output,
    );
    expect(output.output).not.toContain("[Skill Suggestion");
  });

  test("triggers on domain shift from backend-ts to python", async () => {
    const hook = createSkillDomainDetectorHook(SKILLS);

    const out1 = {
      title: "",
      output: "  /src/server.ts\ncontent",
      metadata: {},
    };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "1" },
      out1,
    );

    const out2 = {
      title: "",
      output: "  /src/main.py\ncontent",
      metadata: {},
    };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "2" },
      out2,
    );
    expect(out2.output).toContain("[Skill Suggestion");
    expect(out2.output).toContain("domain shift to python");
  });

  test("does not trigger shift between related domains (ts/tsx)", async () => {
    const hook = createSkillDomainDetectorHook(SKILLS);

    const out1 = {
      title: "",
      output: "  /src/server.ts\ncontent",
      metadata: {},
    };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "1" },
      out1,
    );

    const out2 = {
      title: "",
      output: "  /src/component.tsx\ncontent",
      metadata: {},
    };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "2" },
      out2,
    );
    expect(out2.output).not.toContain("[Skill Suggestion");
  });

  test("does not trigger on same domain", async () => {
    const hook = createSkillDomainDetectorHook(SKILLS);

    const out1 = { title: "", output: "  /src/a.tsx\ncontent", metadata: {} };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "1" },
      out1,
    );

    const out2 = { title: "", output: "  /src/b.tsx\ncontent", metadata: {} };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "2" },
      out2,
    );
    expect(out2.output).not.toContain("[Skill Suggestion");
  });

  test("cleans up on session.compacted", async () => {
    const hook = createSkillDomainDetectorHook(SKILLS);

    const out1 = { title: "", output: "  /src/a.ts\ncontent", metadata: {} };
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "sis-session", callID: "1" },
      out1,
    );

    await hook.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "sis-session" },
      },
    });

    expect(tracker.current("sis-session")).toBeUndefined();
  });
});
