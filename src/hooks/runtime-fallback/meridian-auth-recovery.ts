import { getErrorMessage } from "./error-classifier"
import { log } from "../../shared/logger"
import { HOOK_NAME } from "./constants"

/**
 * Meridian auth-error detection + profile reassignment.
 *
 * When a session hits an auth-expired Meridian profile, the fastest
 * recovery is to force-switch the profile (via the multi-profile plugin's
 * exposed `__meridianReassign` global) and retry with the same model.
 * This avoids unnecessary model downgrades when the underlying issue is
 * just a stale OAuth token on one profile, not a model/provider problem.
 */

const AUTH_ERROR_PATTERNS: RegExp[] = [
  /authentication\s+expired/i,
  /authentication\s+invalid/i,
  /invalid_grant/i,
  /claude\s+login/i,
  /restart\s+the\s+proxy/i,
  /(?:^|[^0-9])401(?:[^0-9]|$)/,
  /token.{0,20}(?:expired|invalid)/i,
  /unauthorized/i,
]

const QUOTA_ERROR_PATTERNS: RegExp[] = [
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
]

type MeridianReassign = (sessionID: string, reason?: string) => string | null
type MeridianStatus = () => {
  profiles: string[]
  cooldowns: Array<{ profile: string; until: number; reason: string }>
  sessionAffinity: number
}

interface MeridianRegistry {
  __meridianReassign?: MeridianReassign
  __meridianProfileStatus?: MeridianStatus
}

export function isMeridianAuthError(error: unknown): boolean {
  const msg = getErrorMessage(error)
  if (!msg) return false
  return AUTH_ERROR_PATTERNS.some((p) => p.test(msg))
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
 * Reason passed to the Meridian plugin when forcing a reassign from
 * the runtime-fallback side.
 */
export type MeridianReassignReason = "auth_expired" | "rate_limit" | "weekly_limit"

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
