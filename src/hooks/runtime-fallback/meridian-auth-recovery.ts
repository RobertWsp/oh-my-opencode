import { getErrorMessage } from "./error-classifier"
import { log } from "../../shared/logger"
import { HOOK_NAME } from "./constants"
import {
  NO_SUBSCRIPTION_PATTERNS,
  AUTH_ERROR_PATTERNS,
  QUOTA_ERROR_PATTERNS,
  matchesAny,
} from "./meridian-error-patterns"

/**
 * Meridian auth-error detection + profile reassignment.
 *
 * When a session hits an auth-expired Meridian profile, the fastest
 * recovery is to force-switch the profile (via the multi-profile plugin's
 * exposed `__meridianReassign` global) and retry with the same model.
 * This avoids unnecessary model downgrades when the underlying issue is
 * just a stale OAuth token on one profile, not a model/provider problem.
 *
 * Error patterns live in `./meridian-error-patterns` as the single source
 * of truth shared with opencode-fork and meridian-setup. Do NOT duplicate
 * patterns here.
 */

/**
 * Pattern to extract the reset time from messages like:
 *   "You've hit your limit · resets 5pm (America/Sao_Paulo)"
 *   "Your limit resets at 11am"
 *   "resets 5:30pm (America/Sao_Paulo)"
 *
 * Returns a Date or null. Handles ambiguous time zones by trusting the
 * tz in parens when present; falls back to local time otherwise.
 */
export function parseResetAt(msg: string, now = Date.now()): number | null {
  // Capture: hour, optional minutes, am/pm, optional timezone
  const m = msg.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i)
  if (!m) return null
  const [, hh, mm, ampm, tz] = m
  let hour = parseInt(hh, 10)
  const minute = mm ? parseInt(mm, 10) : 0
  if (ampm.toLowerCase() === "pm" && hour < 12) hour += 12
  if (ampm.toLowerCase() === "am" && hour === 12) hour = 0

  // Compute the reset timestamp in the target timezone (or local if none).
  const target = tz ? tz.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone
  const ref = new Date(now)
  // Build a "today at HH:MM in target tz" timestamp using Intl tricks:
  //   1) format "now" as the tz-local wall clock
  //   2) compute offset between utc and tz-local
  //   3) target utc = desired_local_ms - offset
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: target,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const parts = Object.fromEntries(fmt.formatToParts(ref).map((p) => [p.type, p.value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  // Build UTC candidate for "today HH:MM tz-local"
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute)
  // Compute offset between tz-local clock and UTC for the base ref
  const tzClockAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    Number(parts.hour),
    Number(parts.minute),
  )
  const offset = tzClockAsUtc - ref.getTime()
  let resetAt = asIfUtc - offset
  // If the resulting time is in the past, push to tomorrow.
  if (resetAt <= now) resetAt += 24 * 60 * 60 * 1000
  return resetAt
}

type MeridianReassign = (sessionID: string, reason?: string) => string | null
type MeridianStatus = () => {
  profiles: string[]
  cooldowns: Array<{ profile: string; until: number; reason: string }>
  sessionAffinity: number
}
type MeridianRefreshProfile = (profile: string) => Promise<boolean>

interface MeridianRegistry {
  __meridianReassign?: MeridianReassign
  __meridianProfileStatus?: MeridianStatus
  __meridianRefreshProfile?: MeridianRefreshProfile
}

export function isMeridianAuthError(error: unknown): boolean {
  const msg = getErrorMessage(error)
  if (!msg) return false
  // Subscription errors also match 401/unauthorized patterns but mean
  // something different (account has no Max access). Exclude them here so
  // they route to the subscription branch instead of getting a short
  // auth-expired cooldown that retries uselessly.
  if (NO_SUBSCRIPTION_PATTERNS.some((p) => p.test(msg))) return false
  return AUTH_ERROR_PATTERNS.some((p) => p.test(msg))
}

/**
 * Account-level "no active subscription" / "organization does not have
 * access" errors. Re-login won't help — the token is valid but the
 * account lost its Max subscription. Profile must be parked in a long
 * cooldown (1y on the plugin side) so other profiles are preferred.
 */
export function isMeridianSubscriptionError(error: unknown): boolean {
  const msg = getErrorMessage(error)
  if (!msg) return false
  return NO_SUBSCRIPTION_PATTERNS.some((p) => p.test(msg))
}

/**
 * Profile-level quota / rate-limit errors that benefit from profile
 * switch (same as auth errors) — the underlying account hit a
 * per-window cap but other profiles may still have budget.
 */
export function isMeridianQuotaError(error: unknown): boolean {
  const msg = getErrorMessage(error)
  if (!msg) return false
  return QUOTA_ERROR_PATTERNS.some((p) => p.test(msg))
}

/**
 * Refines the quota classification into the specific window that was
 * exhausted. "weekly" shows up as literal text; everything else (5-hour
 * session caps, model-level rate limits) we lump into "5h" since that's
 * the user-facing unit on Claude Max subscriptions.
 */
export function classifyQuotaKind(error: unknown): "5h" | "weekly" | null {
  const msg = getErrorMessage(error)
  if (!msg) return null
  if (!QUOTA_ERROR_PATTERNS.some((p) => p.test(msg))) return null
  if (/weekly/i.test(msg)) return "weekly"
  return "5h"
}

/**
 * Reason passed to the Meridian plugin when forcing a reassign from
 * the runtime-fallback side.
 */
export type MeridianReassignReason =
  | "auth_expired"
  | "rate_limit"
  | "weekly_limit"
  | "no_subscription"

export function tryReassignMeridianProfileWithReason(
  sessionID: string,
  reason: MeridianReassignReason,
): string | null {
  const registry = globalThis as unknown as MeridianRegistry
  const reassign = registry.__meridianReassign
  if (typeof reassign !== "function") {
    log(`[${HOOK_NAME}] Meridian reassign not available — plugin not loaded?`, {
      sessionID,
      reason,
    })
    return null
  }
  try {
    const newProfile = reassign(sessionID, reason)
    log(`[${HOOK_NAME}] Meridian profile reassigned`, {
      sessionID,
      reason,
      newProfile: newProfile ?? "(none — all profiles in cooldown)",
    })
    return newProfile
  } catch (error) {
    log(`[${HOOK_NAME}] Meridian reassign threw`, {
      sessionID,
      reason,
      error: String(error),
    })
    return null
  }
}

export function tryReassignMeridianProfile(sessionID: string): string | null {
  const registry = globalThis as unknown as MeridianRegistry
  const reassign = registry.__meridianReassign
  if (typeof reassign !== "function") {
    log(`[${HOOK_NAME}] Meridian reassign not available — plugin not loaded?`, {
      sessionID,
    })
    return null
  }
  try {
    const newProfile = reassign(sessionID, "auth_expired")
    log(`[${HOOK_NAME}] Meridian profile reassigned`, {
      sessionID,
      newProfile: newProfile ?? "(none — all profiles in cooldown)",
    })
    return newProfile
  } catch (error) {
    log(`[${HOOK_NAME}] Meridian reassign threw`, {
      sessionID,
      error: String(error),
    })
    return null
  }
}

export function getMeridianProfileStatus(): ReturnType<MeridianStatus> | null {
  const registry = globalThis as unknown as MeridianRegistry
  const status = registry.__meridianProfileStatus
  if (typeof status !== "function") return null
  try {
    return status()
  } catch {
    return null
  }
}

/**
 * Refresh-first recovery: when a session hits auth_expired on its current
 * profile, try to refresh the OAuth token in place BEFORE falling back to
 * reassigning to another profile. In ~90% of cases the refresh succeeds
 * (access_token expired but refresh_token still valid) — much cheaper than
 * rotating to a different account and bleeding session affinity.
 *
 * Returns:
 *   - "refreshed": token refreshed in place, same profile works now
 *   - "rotated": refresh failed, picked a different profile via reassign
 *   - "no_profile": refresh failed AND no alternate healthy profile exists
 */
export async function tryRecoverMeridianAuth(
  sessionID: string,
): Promise<{ outcome: "refreshed" | "rotated" | "no_profile"; profile: string | null }> {
  const registry = globalThis as unknown as MeridianRegistry
  const refresh = registry.__meridianRefreshProfile
  const status = registry.__meridianProfileStatus

  // Identify the session's current profile via status (the plugin holds
  // this in sessionProfile keyed by sessionID, but we only have a read view
  // via __meridianProfileStatus). Simpler: let the plugin itself handle
  // refresh for the session's active profile by scheduling a sweep-like
  // action. We expose a per-session trigger via reassign anyway, so the
  // safe approach is:
  //   1. Call refresh on EACH profile currently cooldown=auth_expired —
  //      cheap, single-flight deduplicates, and matches the session's own
  //      profile if it's among them.
  //   2. If any refresh returned true, call reassign to let pick() choose
  //      again (which will now find the freshly-refreshed profile valid).
  if (typeof refresh === "function" && typeof status === "function") {
    try {
      const snap = status()
      const authExpiredProfiles = snap.cooldowns
        .filter((c) => c.reason === "auth_expired")
        .map((c) => c.profile)
      // Also refresh the session's currently-affined profile (if healthy
      // today, it may just have expired mid-stream). We can't read
      // sessionProfile from here; skip for now and rely on auth_expired
      // cooldown match.
      if (authExpiredProfiles.length > 0) {
        const results = await Promise.all(authExpiredProfiles.map((p) => refresh(p).catch(() => false)))
        const anyOk = results.some(Boolean)
        if (anyOk) {
          log(`[${HOOK_NAME}] Meridian refresh-first succeeded before rotating`, {
            sessionID,
            refreshed: authExpiredProfiles.filter((_p, i) => results[i]),
          })
          // The plugin's pick() will now find the refreshed profile valid;
          // no reassign needed.
          return { outcome: "refreshed", profile: null }
        }
      }
    } catch (err) {
      log(`[${HOOK_NAME}] Meridian refresh-first threw (falling back to reassign)`, {
        sessionID,
        error: String(err),
      })
    }
  }

  // Fallback: reassign to another profile.
  const newProfile = tryReassignMeridianProfileWithReason(sessionID, "auth_expired")
  if (newProfile) return { outcome: "rotated", profile: newProfile }
  return { outcome: "no_profile", profile: null }
}
