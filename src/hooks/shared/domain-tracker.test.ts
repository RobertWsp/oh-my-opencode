import { describe, expect, test, beforeEach } from "bun:test";
import {
  extractExt,
  toDomain,
  extractPath,
  update,
  current,
  clear,
} from "./domain-tracker";

describe("extractExt", () => {
  test("extracts simple extension", () => {
    expect(extractExt("/src/app.ts")).toBe(".ts");
  });

  test("extracts tsx extension", () => {
    expect(extractExt("/src/component.tsx")).toBe(".tsx");
  });

  test("extracts compound test extension", () => {
    expect(extractExt("/src/app.test.ts")).toBe(".test.ts");
  });

  test("extracts compound spec extension", () => {
    expect(extractExt("/src/app.spec.tsx")).toBe(".spec.tsx");
  });

  test("extracts python extension", () => {
    expect(extractExt("/src/main.py")).toBe(".py");
  });

  test("returns empty for no extension", () => {
    expect(extractExt("/src/Dockerfile")).toBe("");
  });

  test("handles nested paths", () => {
    expect(extractExt("/a/b/c/d/file.vue")).toBe(".vue");
  });

  test("strips .bak suffix before extracting", () => {
    expect(extractExt("/src/app.ts.bak")).toBe(".ts");
  });

  test("strips .old suffix before extracting", () => {
    expect(extractExt("/src/app.tsx.old")).toBe(".tsx");
  });

  test("strips .tmp suffix before extracting", () => {
    expect(extractExt("/src/main.py.tmp")).toBe(".py");
  });

  test("strips trailing tilde (vim backup)", () => {
    expect(extractExt("/src/app.ts~")).toBe(".ts");
  });

  test("strips .orig suffix before extracting", () => {
    expect(extractExt("/src/app.ts.orig")).toBe(".ts");
  });

  test("handles compound test with backup suffix", () => {
    expect(extractExt("/src/app.test.ts.bak")).toBe(".test.ts");
  });
});

describe("toDomain", () => {
  test("tsx maps to frontend", () => {
    expect(toDomain(".tsx")).toBe("frontend");
  });

  test("py maps to python", () => {
    expect(toDomain(".py")).toBe("python");
  });

  test("ts maps to backend-ts", () => {
    expect(toDomain(".ts")).toBe("backend-ts");
  });

  test("css maps to styling", () => {
    expect(toDomain(".css")).toBe("styling");
  });

  test("sql maps to database", () => {
    expect(toDomain(".sql")).toBe("database");
  });

  test("unknown extension maps to unknown", () => {
    expect(toDomain(".xyz")).toBe("unknown");
  });

  test("test.ts maps to testing", () => {
    expect(toDomain(".test.ts")).toBe("testing");
  });

  test("html maps to frontend", () => {
    expect(toDomain(".html")).toBe("frontend");
  });

  test("json maps to devops", () => {
    expect(toDomain(".json")).toBe("devops");
  });

  test("sh maps to devops", () => {
    expect(toDomain(".sh")).toBe("devops");
  });

  test("xml maps to devops", () => {
    expect(toDomain(".xml")).toBe("devops");
  });
});

describe("extractPath", () => {
  test("extracts path from read tool output", () => {
    const output = "  /home/user/src/app.tsx\nfile content...";
    expect(extractPath(output, "read")).toBe("/home/user/src/app.tsx");
  });

  test("extracts path from grep tool output", () => {
    const output = "Found 3 matches\n/home/user/src/main.py:10: def foo():";
    expect(extractPath(output, "grep")).toBe("/home/user/src/main.py");
  });

  test("extracts path from bash tool output", () => {
    const output = "error in /home/user/src/index.ts:5:10";
    expect(extractPath(output, "bash")).toBe("/home/user/src/index.ts");
  });

  test("returns undefined for output with no paths", () => {
    expect(extractPath("some output", "task")).toBeUndefined();
  });

  test("extracts path from any tool output", () => {
    const output = "Processing /home/user/src/main.py for analysis";
    expect(extractPath(output, "mcp_custom_tool")).toBe(
      "/home/user/src/main.py",
    );
  });

  test("returns undefined when no path found", () => {
    expect(extractPath("no paths here", "read")).toBeUndefined();
  });

  test("extracts relative path", () => {
    const output = "Found issue in src/components/Button.tsx";
    expect(extractPath(output, "grep")).toBe("src/components/Button.tsx");
  });

  test("extracts nested relative path", () => {
    const output = "Error at packages/core/src/index.ts";
    expect(extractPath(output, "bash")).toBe("packages/core/src/index.ts");
  });
});

describe("domain tracking", () => {
  const sid = "test-session";

  beforeEach(() => {
    clear(sid);
  });

  test("first update returns false (no shift)", () => {
    expect(update(sid, "frontend")).toBe(false);
  });

  test("same domain returns false", () => {
    update(sid, "frontend");
    expect(update(sid, "frontend")).toBe(false);
  });

  test("different domain returns true (shift detected)", () => {
    update(sid, "frontend");
    expect(update(sid, "python")).toBe(true);
  });

  test("related domains do not trigger shift (ts/tsx)", () => {
    update(sid, "backend-ts");
    expect(update(sid, "frontend")).toBe(false);
  });

  test("related domains do not trigger shift (frontend/styling)", () => {
    update(sid, "frontend");
    expect(update(sid, "styling")).toBe(false);
  });

  test("unrelated domains trigger shift (python/frontend)", () => {
    update(sid, "python");
    expect(update(sid, "frontend")).toBe(true);
  });

  test("related domain updates current", () => {
    update(sid, "backend-ts");
    update(sid, "frontend");
    expect(current(sid)).toBe("frontend");
  });

  test("current returns current domain", () => {
    update(sid, "frontend");
    expect(current(sid)).toBe("frontend");
  });

  test("current updates after shift", () => {
    update(sid, "frontend");
    update(sid, "python");
    expect(current(sid)).toBe("python");
  });

  test("current returns undefined for unknown session", () => {
    expect(current("nonexistent")).toBeUndefined();
  });

  test("clear removes tracking", () => {
    update(sid, "frontend");
    clear(sid);
    expect(current(sid)).toBeUndefined();
  });
});
