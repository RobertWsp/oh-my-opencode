import { describe, expect, test, beforeEach } from "bun:test";
import { reset, acquire, owner, clear } from "./skill-suggestion-gate";

const sid = "test-session";
const sid2 = "session-b";

describe("skill-suggestion-gate", () => {
  beforeEach(() => {
    reset(sid);
    reset(sid2);
  });

  test("first acquire succeeds", () => {
    expect(acquire(sid, "error-reactor")).toBe(true);
  });

  test("second acquire on same session fails", () => {
    acquire(sid, "error-reactor");
    expect(acquire(sid, "domain-detector")).toBe(false);
  });

  test("owner returns active source", () => {
    acquire(sid, "error-reactor");
    expect(owner(sid)).toBe("error-reactor");
  });

  test("owner is undefined before acquire", () => {
    expect(owner(sid)).toBeUndefined();
  });

  test("reset allows new acquire", () => {
    acquire(sid, "error-reactor");
    reset(sid);
    expect(acquire(sid, "domain-detector")).toBe(true);
    expect(owner(sid)).toBe("domain-detector");
  });

  test("reset clears owner", () => {
    acquire(sid, "error-reactor");
    reset(sid);
    expect(owner(sid)).toBeUndefined();
  });

  test("sessions are isolated — acquire on A does not block B", () => {
    acquire(sid, "error-reactor");
    expect(acquire(sid2, "domain-detector")).toBe(true);
  });

  test("reset on A does not affect B", () => {
    acquire(sid, "error-reactor");
    acquire(sid2, "domain-detector");
    reset(sid);
    expect(owner(sid)).toBeUndefined();
    expect(owner(sid2)).toBe("domain-detector");
  });

  test("clear removes session gate", () => {
    acquire(sid, "error-reactor");
    clear(sid);
    expect(owner(sid)).toBeUndefined();
    expect(acquire(sid, "domain-detector")).toBe(true);
  });
});
