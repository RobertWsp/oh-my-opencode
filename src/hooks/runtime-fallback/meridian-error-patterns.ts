/**
 * Single source of truth for Meridian subprocess error patterns.
 *
 * These patterns are consumed by:
 *   - oh-my-opencode/hooks/runtime-fallback (this package)
 *   - opencode-fork/src/session/processor.ts (via copied constants)
 *   - meridian-setup/plugin/meridian-multiprofile.ts (via copied constants)
 *
 * When adding a new pattern, update this file AND propagate to the other
 * two consumers. Divergence means a subprocess error in one error type will
 * route through the wrong classification (or none at all).
 *
 * Classification is exclusive and ordered:
 *   no_subscription > auth_expired > weekly_limit > rate_limit
 * so auth-ish 401 responses that are actually subscription issues get a
 * long cooldown instead of a useless 30-minute retry.
 */

export const NO_SUBSCRIPTION_PATTERNS: readonly RegExp[] = [
  /organization\s+does\s+not\s+have\s+access/i,
  /no\s+active\s+(?:claude\s+)?subscription/i,
  /subscription\s+required/i,
  /please\s+upgrade/i,
  /contact\s+your\s+administrator/i,
]

export const AUTH_ERROR_PATTERNS: readonly RegExp[] = [
  /authentication\s+expired/i,
  /authentication\s+invalid/i,
  /invalid_grant/i,
  /claude\s+login/i,
  /restart\s+the\s+proxy/i,
  /(?:^|[^0-9])401(?:[^0-9]|$)/,
  /token.{0,20}(?:expired|invalid)/i,
  /unauthorized/i,
]

export const QUOTA_ERROR_PATTERNS: readonly RegExp[] = [
  /usage\s+limit/i,
  /reached\s+your\s+(?:usage|limit|quota)/i,
  /has\s+been\s+reached/i,
  /exhausted\s+your\s+capacity/i,
  /quota\s+will\s+reset/i,
  /quota.?exceeded/i,
  /weekly\s+(?:usage\s+)?limit/i,
  /5[-\s]?hour\s+limit/i,
  /hourly\s+limit/i,
  /all\s+credentials\s+for\s+model/i,
  /(?:^|[^0-9])429(?:[^0-9]|$)/,
  /hit\s+your\s+limit/i,
  /you['\u2019]?ve\s+hit/i,
  /resets?\s+at?\s+\d+\s*(?:am|pm)/i,
  /resets?\s+\d+\s*(?:am|pm)/i,
  /weekly.*reset/i,
  /rate.?limit/i,
  /too.?many.?requests/i,
  /cool(?:ing)?\s+down/i,
  /out\s+of\s+credits?/i,
]

/**
 * Weekly-window specific patterns — sub-case of QUOTA with longer cooldowns
 * (hours vs 5min). classifyReason() checks this BEFORE generic QUOTA so
 * "weekly limit" messages get the right bucket.
 */
export const WEEKLY_LIMIT_PATTERNS: readonly RegExp[] = [
  /weekly\s+(?:usage\s+)?limit/i,
  /weekly\s+quota/i,
  /resets?\s+(?:on|at|in)\s+.{0,30}(?:next\s+week|\d+\s+day)/i,
  /weekly.*reset/i,
]

/**
 * Markers that identify ANY Meridian-wrapped subprocess error, regardless of
 * classification. Used as a fast pre-filter in stream parsing where we just
 * want to know "is this content a Meridian error at all" before routing to
 * specific handlers.
 */
export const SUBPROCESS_ERROR_MARKERS: readonly RegExp[] = [
  /Claude Code returned an error result/i,
  /organization\s+does\s+not\s+have\s+access/i,
  /contact\s+your\s+administrator/i,
  /you['\u2019]?ve\s+hit\s+your\s+limit/i,
  /hit\s+your\s+limit.*resets?\s+\d/i,
  /please\s+login\s+again/i,
  /no\s+active\s+(?:claude\s+)?subscription/i,
  /subscription\s+required/i,
]

/**
 * Anchored variant — for detecting an error at the very start of an
 * assistant response text block (where Meridian would wrap the subprocess
 * stdout as normal output).
 */
export const SUBPROCESS_ERROR_PREFIX = new RegExp(
  "^\\s*(?:claude code returned|you['\u2019]?ve hit|your organization does not have|please login again|custom betas are only)",
  "i",
)

export function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text))
}

export function isSubprocessError(text: string): boolean {
  return SUBPROCESS_ERROR_PREFIX.test(text) || matchesAny(text, SUBPROCESS_ERROR_MARKERS)
}

export function classifyReason(
  text: string,
): "no_subscription" | "auth_expired" | "weekly_limit" | "rate_limit" | null {
  if (matchesAny(text, NO_SUBSCRIPTION_PATTERNS)) return "no_subscription"
  if (matchesAny(text, AUTH_ERROR_PATTERNS)) return "auth_expired"
  if (matchesAny(text, WEEKLY_LIMIT_PATTERNS)) return "weekly_limit"
  if (matchesAny(text, QUOTA_ERROR_PATTERNS)) return "rate_limit"
  return null
}
