import { describe, expect, test, beforeEach, mock } from "bun:test";
import { createSkillCompactionReloaderHook } from "./hook";
import { ContextCollector } from "../../features/context-injector/collector";
import * as tracker from "../shared/domain-tracker";

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
];

describe("createSkillCompactionReloaderHook", () => {
  let collector: ContextCollector;

  beforeEach(() => {
    collector = new ContextCollector();
    tracker.clear("test-session");
  });

  test("ignores non-compaction events", async () => {
    const hook = createSkillCompactionReloaderHook(SKILLS, collector);
    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "test-session" },
      },
    });
    expect(collector.hasPending("test-session")).toBe(false);
  });

  test("ignores compaction with no session ID", async () => {
    const hook = createSkillCompactionReloaderHook(SKILLS, collector);
    await hook.event({ event: { type: "session.compacted", properties: {} } });
    expect(collector.hasPending("test-session")).toBe(false);
  });

  test("ignores compaction when no domain tracked", async () => {
    const hook = createSkillCompactionReloaderHook(SKILLS, collector);
    await hook.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "test-session" },
      },
    });
    expect(collector.hasPending("test-session")).toBe(false);
  });

  test("registers context after compaction with known domain", async () => {
    tracker.update("test-session", "frontend");
    const hook = createSkillCompactionReloaderHook(SKILLS, collector);

    await hook.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "test-session" },
      },
    });

    expect(collector.hasPending("test-session")).toBe(true);
    const pending = collector.consume("test-session");
    expect(pending.merged).toContain("Skill Reload");
    expect(pending.merged).toContain("frontend");
  });

  test("registers context with session ID from info.id", async () => {
    tracker.update("test-session", "python");
    const hook = createSkillCompactionReloaderHook(SKILLS, collector);

    await hook.event({
      event: {
        type: "session.compacted",
        properties: { info: { id: "test-session" } },
      },
    });

    expect(collector.hasPending("test-session")).toBe(true);
    const pending = collector.consume("test-session");
    expect(pending.merged).toContain("python");
  });

  test("does not register for unknown domain", async () => {
    tracker.update("test-session", "unknown");
    const hook = createSkillCompactionReloaderHook(SKILLS, collector);

    await hook.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "test-session" },
      },
    });

    expect(collector.hasPending("test-session")).toBe(false);
  });

  test("suggests relevant skills for the domain", async () => {
    tracker.update("test-session", "frontend");
    const hook = createSkillCompactionReloaderHook(SKILLS, collector);

    await hook.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "test-session" },
      },
    });

    const pending = collector.consume("test-session");
    expect(pending.merged).toContain("software-frontend");
  });
});
