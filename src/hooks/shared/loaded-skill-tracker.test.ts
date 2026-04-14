import { describe, expect, test, beforeEach } from "bun:test";
import { record, isLoaded, all, clear } from "./loaded-skill-tracker";

describe("loaded-skill-tracker", () => {
  const sid = "test-session";

  beforeEach(() => {
    clear(sid);
  });

  test("isLoaded returns false for unknown session", () => {
    expect(isLoaded("nonexistent", "vitest-testing")).toBe(false);
  });

  test("isLoaded returns false before record", () => {
    expect(isLoaded(sid, "vitest-testing")).toBe(false);
  });

  test("isLoaded returns true after record", () => {
    record(sid, "vitest-testing");
    expect(isLoaded(sid, "vitest-testing")).toBe(true);
  });

  test("matching is case-insensitive", () => {
    record(sid, "Vitest-Testing");
    expect(isLoaded(sid, "vitest-testing")).toBe(true);
  });

  test("all returns recorded skills", () => {
    record(sid, "vitest-testing");
    record(sid, "ruff-dev");
    expect(all(sid).sort()).toEqual(["ruff-dev", "vitest-testing"]);
  });

  test("all returns empty for unknown session", () => {
    expect(all("nonexistent")).toEqual([]);
  });

  test("clear removes all records", () => {
    record(sid, "vitest-testing");
    clear(sid);
    expect(isLoaded(sid, "vitest-testing")).toBe(false);
    expect(all(sid)).toEqual([]);
  });

  test("sessions are isolated", () => {
    record("session-a", "vitest-testing");
    record("session-b", "ruff-dev");
    expect(isLoaded("session-a", "vitest-testing")).toBe(true);
    expect(isLoaded("session-a", "ruff-dev")).toBe(false);
    expect(isLoaded("session-b", "ruff-dev")).toBe(true);
    expect(isLoaded("session-b", "vitest-testing")).toBe(false);
  });

  test("duplicate records are deduplicated", () => {
    record(sid, "vitest-testing");
    record(sid, "vitest-testing");
    expect(all(sid)).toEqual(["vitest-testing"]);
  });
});
