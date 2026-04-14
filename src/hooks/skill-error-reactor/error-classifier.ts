import {
  PATTERNS,
  type ClassifiedError,
  type ErrorCategory,
} from "./error-patterns";

export type { ErrorCategory, ClassifiedError };

function extractJSON(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return (
      parsed.error ?? parsed.message ?? parsed.detail ?? parsed.msg ?? undefined
    );
  } catch {
    return undefined;
  }
}

export function classify(output: string): ClassifiedError | undefined {
  for (const pattern of PATTERNS) {
    if (pattern.re.test(output)) {
      return { category: pattern.category, keywords: pattern.keywords };
    }
  }

  const json = extractJSON(output);
  if (json) {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(json)) {
        return { category: pattern.category, keywords: pattern.keywords };
      }
    }
  }

  return undefined;
}

export function hasError(
  output: string,
  metadata: Record<string, unknown>,
): boolean {
  const code = metadata.exitCode ?? metadata.exit_code;
  if (typeof code === "number" && code !== 0) return true;

  const mcp = metadata.error_code;
  if (typeof mcp === "number" && mcp !== 0) return true;
  if (metadata.status === "error" || metadata.isError === true) return true;

  if (/^Error:/m.test(output)) return true;
  if (/error\[E\d+\]/i.test(output)) return true;

  const json = extractJSON(output);
  if (json && /^Error:|error:/i.test(json)) return true;

  return false;
}
