import { describe, expect, test, beforeEach, mock } from "bun:test";
import { createSkillErrorReactorHook } from "./hook";
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
    name: "vitest-testing",
    description:
      "Modern TypeScript JavaScript testing with Vitest type assertions",
    location: "user" as const,
  },
  {
    name: "ruff-dev",
    description: "Python linter formatter import sorter ruff",
    location: "user" as const,
  },
  {
    name: "pydantic-dev",
    description: "Python data validation Pydantic module type models",
    location: "user" as const,
  },
  {
    name: "zod",
    description: "TypeScript type schema validation inference",
    location: "user" as const,
  },
  {
    name: "software-frontend",
    description: "Production frontend React Next.js",
    location: "user" as const,
  },
  {
    name: "security-practices",
    description: "Security CORS auth JWT practices",
    location: "user" as const,
  },
];

describe("createSkillErrorReactorHook", () => {
  const hook = createSkillErrorReactorHook(SKILLS);

  beforeEach(() => {
    gate.reset("sis-session");
  });

  test("does not trigger on non-error output", async () => {
    const output = { title: "", output: "ok", metadata: {} };
    await hook["tool.execute.after"](
      { tool: "task", sessionID: "sis-session", callID: "1" },
      output,
    );
    expect(output.output).toBe("ok");
  });

  test("does not trigger for non-target agents", async () => {
    const output = {
      title: "",
      output: "TS2345: error",
      metadata: { exitCode: 1 },
    };
    await hook["tool.execute.after"](
      { tool: "bash", sessionID: "other-session", callID: "1" },
      output,
    );
    expect(output.output).toBe("TS2345: error");
  });

  test("does not trigger when no error detected", async () => {
    const output = { title: "", output: "all good", metadata: { exitCode: 0 } };
    await hook["tool.execute.after"](
      { tool: "bash", sessionID: "sis-session", callID: "1" },
      output,
    );
    expect(output.output).toBe("all good");
  });

  test("suggests skills on typescript error", async () => {
    const output = {
      title: "",
      output: "error TS2345: Argument of type",
      metadata: { exitCode: 1 },
    };
    await hook["tool.execute.after"](
      { tool: "bash", sessionID: "sis-session", callID: "1" },
      output,
    );
    expect(output.output).toContain("[Skill Suggestion");
    expect(output.output).toContain("typescript");
  });

  test("suggests skills on python error", async () => {
    const hook2 = createSkillErrorReactorHook(SKILLS);
    const output = {
      title: "",
      output: "ModuleNotFoundError: No module named 'foo'",
      metadata: { exitCode: 1 },
    };
    await hook2["tool.execute.after"](
      { tool: "bash", sessionID: "sis-session", callID: "1" },
      output,
    );
    expect(output.output).toContain("[Skill Suggestion");
    expect(output.output).toContain("python");
  });

  test("respects cooldown", async () => {
    const hook3 = createSkillErrorReactorHook(SKILLS);
    const output1 = {
      title: "",
      output: "error TS2345: type error",
      metadata: { exitCode: 1 },
    };
    await hook3["tool.execute.after"](
      { tool: "bash", sessionID: "sis-session", callID: "1" },
      output1,
    );
    expect(output1.output).toContain("[Skill Suggestion");

    const output2 = {
      title: "",
      output: "error TS2345: another error",
      metadata: { exitCode: 1 },
    };
    await hook3["tool.execute.after"](
      { tool: "bash", sessionID: "sis-session", callID: "2" },
      output2,
    );
    expect(output2.output).not.toContain("[Skill Suggestion");
  });

  test("cleans up on session.deleted", async () => {
    const hook4 = createSkillErrorReactorHook(SKILLS);
    const output = {
      title: "",
      output: "error TS2345:",
      metadata: { exitCode: 1 },
    };
    await hook4["tool.execute.after"](
      { tool: "bash", sessionID: "sis-session", callID: "1" },
      output,
    );

    await hook4.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "sis-session" } },
      },
    });

    gate.reset("sis-session");
    const output2 = {
      title: "",
      output: "error TS2345:",
      metadata: { exitCode: 1 },
    };
    await hook4["tool.execute.after"](
      { tool: "bash", sessionID: "sis-session", callID: "2" },
      output2,
    );
    expect(output2.output).toContain("[Skill Suggestion");
  });
});
