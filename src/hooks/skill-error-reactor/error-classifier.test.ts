import { describe, expect, test } from "bun:test";
import { classify, hasError } from "./error-classifier";

describe("classify", () => {
  test("detects TypeScript error codes", () => {
    const result = classify(
      "error TS2345: Argument of type 'string' is not assignable",
    );
    expect(result?.category).toBe("typescript");
    expect(result?.keywords).toContain("typescript");
  });

  test("detects type assignability errors", () => {
    const result = classify("Type 'string' is not assignable to type 'number'");
    expect(result?.category).toBe("typescript");
  });

  test("detects Cannot find module", () => {
    const result = classify("Cannot find module './foo'");
    expect(result?.category).toBe("typescript");
    expect(result?.keywords).toContain("module");
  });

  test("detects Python ModuleNotFoundError", () => {
    const result = classify("ModuleNotFoundError: No module named 'pandas'");
    expect(result?.category).toBe("python");
    expect(result?.keywords).toContain("python");
  });

  test("detects Python traceback", () => {
    const result = classify("Traceback (most recent call last):\n  File...");
    expect(result?.category).toBe("python");
  });

  test("detects pydantic ValidationError", () => {
    const result = classify(
      "pydantic.error_wrappers.ValidationError: 2 errors",
    );
    expect(result?.category).toBe("python");
    expect(result?.keywords).toContain("pydantic");
  });

  test("detects React hook errors", () => {
    const result = classify(
      "Invalid hook call. Hooks can only be called inside...",
    );
    expect(result?.category).toBe("react");
    expect(result?.keywords).toContain("react");
  });

  test("detects hydration mismatch errors", () => {
    const result = classify(
      "Warning: Text content did not match. Server: hydration mismatch",
    );
    expect(result?.category).toBe("react");
  });

  test("ignores plain hydration word", () => {
    expect(classify("discussing hydration strategies")).toBeUndefined();
  });

  test("detects test failures", () => {
    const result = classify("FAIL src/app.test.ts");
    expect(result?.category).toBe("test");
    expect(result?.keywords).toContain("test");
  });

  test("detects pytest failures", () => {
    const result = classify("pytest: 3 FAILED, 2 passed");
    expect(result?.category).toBe("test");
    expect(result?.keywords).toContain("pytest");
  });

  test("detects Expected/Received assertions", () => {
    const result = classify("Expected: 42\nReceived: undefined");
    expect(result?.category).toBe("test");
  });

  test("detects build failures", () => {
    const result = classify("Build failed with exit code 1");
    expect(result?.category).toBe("build");
  });

  test("detects vite errors", () => {
    const result = classify("[vite] Internal server error: ...");
    expect(result?.category).toBe("build");
  });

  test("detects database relation errors", () => {
    const result = classify('relation "users" does not exist');
    expect(result?.category).toBe("database");
    expect(result?.keywords).toContain("postgres");
  });

  test("detects CORS policy errors", () => {
    const result = classify("Access to fetch blocked by CORS policy");
    expect(result?.category).toBe("security");
    expect(result?.keywords).toContain("cors");
  });

  test("detects CORS block errors", () => {
    const result = classify("CORS error: blocked by policy");
    expect(result?.category).toBe("security");
  });

  test("ignores plain CORS mention", () => {
    const result = classify("configure CORS settings in config file");
    expect(result?.category).not.toBe("security");
  });

  test("detects network errors", () => {
    const result = classify("Error: connect ECONNREFUSED 127.0.0.1:3000");
    expect(result?.category).toBe("network");
  });

  test("detects permission errors", () => {
    const result = classify(
      "Error: EACCES: permission denied, open '/etc/hosts'",
    );
    expect(result?.category).toBe("permission");
  });

  test("detects docker errors", () => {
    const result = classify("docker: Error response from daemon");
    expect(result?.category).toBe("docker");
  });

  test("returns undefined for non-error output", () => {
    expect(classify("Successfully compiled 42 files")).toBeUndefined();
  });

  test("returns undefined for empty output", () => {
    expect(classify("")).toBeUndefined();
  });

  test("classifies Python TypeError with traceback as python", () => {
    const result = classify(
      "Traceback (most recent call last):\n  File 'main.py'\nTypeError: bad arg",
    );
    expect(result?.category).toBe("python");
  });

  test("classifies JS TypeError without traceback as typescript", () => {
    const result = classify("TypeError: undefined is not a function");
    expect(result?.category).toBe("typescript");
  });

  test("classifies standalone SyntaxError as build", () => {
    const result = classify("SyntaxError: Unexpected token '}'");
    expect(result?.category).toBe("build");
    expect(result?.keywords).toContain("syntax");
  });

  test("classifies Python SyntaxError with traceback as python", () => {
    const result = classify(
      "Traceback (most recent call last):\n  File 'main.py'\nSyntaxError: invalid syntax",
    );
    expect(result?.category).toBe("python");
  });

  test("classifies error inside JSON output (MCP tool)", () => {
    const result = classify(
      '{"error": "ModuleNotFoundError: No module named foo"}',
    );
    expect(result?.category).toBe("python");
  });

  test("classifies MCP JSON with message field", () => {
    const result = classify(
      '{"message": "TypeError: undefined is not a function"}',
    );
    expect(result?.category).toBe("typescript");
  });

  test("returns undefined for non-error JSON", () => {
    expect(classify('{"status": "ok", "count": 42}')).toBeUndefined();
  });
});

describe("hasError", () => {
  test("detects non-zero exit code from exitCode", () => {
    expect(hasError("", { exitCode: 1 })).toBe(true);
  });

  test("detects non-zero exit code from exit_code", () => {
    expect(hasError("", { exit_code: 127 })).toBe(true);
  });

  test("exit code 0 is not an error", () => {
    expect(hasError("", { exitCode: 0 })).toBe(false);
  });

  test("detects Error: prefix in output", () => {
    expect(hasError("Error: something broke", {})).toBe(true);
  });

  test("detects Rust-style error codes", () => {
    expect(hasError("error[E0308]: mismatched types", {})).toBe(true);
  });

  test("normal output is not an error", () => {
    expect(hasError("all good", {})).toBe(false);
  });

  test("empty output with no metadata is not an error", () => {
    expect(hasError("", {})).toBe(false);
  });

  test("detects MCP error_code in metadata", () => {
    expect(hasError("", { error_code: 401 })).toBe(true);
  });

  test("detects MCP status error in metadata", () => {
    expect(hasError("", { status: "error" })).toBe(true);
  });

  test("detects MCP isError in metadata", () => {
    expect(hasError("", { isError: true })).toBe(true);
  });

  test("detects error inside JSON output", () => {
    expect(hasError('{"error": "Error: unauthorized"}', {})).toBe(true);
  });

  test("does not flag non-error JSON", () => {
    expect(hasError('{"status": "ok"}', {})).toBe(false);
  });
});
