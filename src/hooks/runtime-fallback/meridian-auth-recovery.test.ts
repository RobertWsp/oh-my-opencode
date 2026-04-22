import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  isMeridianAuthError,
  isMeridianQuotaError,
  isMeridianSubscriptionError,
  tryReassignMeridianProfile,
  tryReassignMeridianProfileWithReason,
  tryRecoverMeridianAuth,
} from "./meridian-auth-recovery"

describe("meridian-auth-recovery", () => {
  const registry = globalThis as unknown as {
    __meridianReassign?: (sessionID: string, reason?: string) => string | null
  }

  afterEach(() => {
    delete registry.__meridianReassign
  })

  describe("isMeridianAuthError", () => {
    test("detects 'authentication expired' message", () => {
      expect(
        isMeridianAuthError({
          error: { message: "Claude authentication expired or invalid. Run 'claude login'..." },
        }),
      ).toBe(true)
    })

    test("detects 'restart the proxy' message", () => {
      expect(
        isMeridianAuthError({ message: "token invalid, restart the proxy after login" }),
      ).toBe(true)
    })

    test("detects 'invalid_grant' message", () => {
      expect(
        isMeridianAuthError({
          data: { error: { message: "OAuth refresh failed: invalid_grant" } },
        }),
      ).toBe(true)
    })

    test("detects 401 status in message", () => {
      expect(isMeridianAuthError("request failed with 401 unauthorized")).toBe(true)
    })

    test("detects generic 'unauthorized'", () => {
      expect(isMeridianAuthError({ message: "Unauthorized" })).toBe(true)
    })

    test("does NOT classify rate-limit as auth", () => {
      expect(
        isMeridianAuthError({ message: "429 too many requests, rate limit hit" }),
      ).toBe(false)
    })

    test("does NOT classify generic 500 as auth", () => {
      expect(isMeridianAuthError({ message: "internal server error 500" })).toBe(false)
    })

    test("handles null/empty gracefully", () => {
      expect(isMeridianAuthError(null)).toBe(false)
      expect(isMeridianAuthError(undefined)).toBe(false)
      expect(isMeridianAuthError({})).toBe(false)
      expect(isMeridianAuthError("")).toBe(false)
    })

    test("does NOT classify 'organization does not have access' as auth (subscription issue)", () => {
      expect(
        isMeridianAuthError({
          message:
            "Claude Code returned an error result: Your organization does not have access to Claude. Please login again or contact your administrator.",
        }),
      ).toBe(false)
    })
  })

  describe("isMeridianSubscriptionError", () => {
    test("detects 'organization does not have access'", () => {
      expect(
        isMeridianSubscriptionError({
          message:
            "Your organization does not have access to Claude. Please login again or contact your administrator.",
        }),
      ).toBe(true)
    })

    test("detects 'no active subscription'", () => {
      expect(
        isMeridianSubscriptionError({ message: "No active Claude subscription on this account" }),
      ).toBe(true)
    })

    test("detects 'contact your administrator'", () => {
      expect(
        isMeridianSubscriptionError({
          message: "Access denied. Please contact your administrator.",
        }),
      ).toBe(true)
    })

    test("does NOT classify plain auth-expired as subscription", () => {
      expect(
        isMeridianSubscriptionError({ message: "Claude authentication expired" }),
      ).toBe(false)
    })

    test("does NOT classify rate-limit as subscription", () => {
      expect(
        isMeridianSubscriptionError({ message: "429 too many requests" }),
      ).toBe(false)
    })

    test("handles null/empty gracefully", () => {
      expect(isMeridianSubscriptionError(null)).toBe(false)
      expect(isMeridianSubscriptionError({})).toBe(false)
      expect(isMeridianSubscriptionError("")).toBe(false)
    })
  })

  describe("tryReassignMeridianProfile", () => {
    beforeEach(() => {
      delete registry.__meridianReassign
    })

    test("returns null when Meridian plugin not loaded", () => {
      expect(tryReassignMeridianProfile("ses_1")).toBe(null)
    })

    test("calls __meridianReassign with auth_expired reason", () => {
      const calls: Array<{ sid: string; reason: string | undefined }> = []
      registry.__meridianReassign = (sid, reason) => {
        calls.push({ sid, reason })
        return "alt2"
      }

      const result = tryReassignMeridianProfile("ses_1")
      expect(result).toBe("alt2")
      expect(calls).toEqual([{ sid: "ses_1", reason: "auth_expired" }])
    })

    test("returns null when reassign returns null (all profiles in cooldown)", () => {
      registry.__meridianReassign = () => null
      expect(tryReassignMeridianProfile("ses_1")).toBe(null)
    })

    test("returns null when reassign throws", () => {
      registry.__meridianReassign = () => {
        throw new Error("boom")
      }
      expect(tryReassignMeridianProfile("ses_1")).toBe(null)
    })

    test("tryReassignMeridianProfileWithReason forwards reason=weekly_limit", () => {
      const calls: Array<{ sid: string; reason: string | undefined }> = []
      registry.__meridianReassign = (sid, reason) => {
        calls.push({ sid, reason })
        return "alt3"
      }
      const result = tryReassignMeridianProfileWithReason("ses_w", "weekly_limit")
      expect(result).toBe("alt3")
      expect(calls).toEqual([{ sid: "ses_w", reason: "weekly_limit" }])
    })
  })

  describe("isMeridianQuotaError", () => {
    test("detects 'usage limit has been reached' (Claude Max weekly)", () => {
      expect(
        isMeridianQuotaError({
          message: "The usage limit has been reached [retrying in 27s attempt #6]",
        }),
      ).toBe(true)
    })

    test("detects 'reached your usage limit'", () => {
      expect(
        isMeridianQuotaError({
          message: "You've reached your usage limit for this month. Please upgrade.",
        }),
      ).toBe(true)
    })

    test("detects 'weekly usage limit'", () => {
      expect(isMeridianQuotaError({ message: "Weekly usage limit exceeded." })).toBe(true)
    })

    test("detects 'exhausted your capacity'", () => {
      expect(isMeridianQuotaError({ message: "You have exhausted your capacity." })).toBe(true)
    })

    test("detects '429' status in message", () => {
      expect(isMeridianQuotaError({ message: "HTTP 429 too many requests" })).toBe(true)
    })

    test("detects 'all credentials for model are cooling down'", () => {
      expect(
        isMeridianQuotaError({
          message: "All credentials for model claude-opus-4-6 are cooling down",
        }),
      ).toBe(true)
    })

    test("does NOT misclassify auth error as quota", () => {
      expect(
        isMeridianQuotaError({
          message: "Claude authentication expired or invalid. Run 'claude login'...",
        }),
      ).toBe(false)
    })

    test("does NOT misclassify generic 500 as quota", () => {
      expect(isMeridianQuotaError({ message: "internal server error 500" })).toBe(false)
    })
  })
})

import { classifyQuotaKind, parseResetAt } from "./meridian-auth-recovery"

describe("Claude Code CLI subscription-cap error", () => {
  test("'hit your limit' classifies as quota", () => {
    expect(isMeridianQuotaError({ message: "You've hit your limit · resets 5pm (America/Sao_Paulo)" })).toBe(true)
  })

  test("'you've hit' also matches", () => {
    expect(isMeridianQuotaError({ message: "You've hit your session cap. Please wait." })).toBe(true)
  })

  test("weekly kind", () => {
    expect(classifyQuotaKind({ message: "weekly usage limit exceeded" })).toBe("weekly")
  })

  test("5h kind for hit-your-limit", () => {
    expect(classifyQuotaKind({ message: "You've hit your limit · resets 5pm (America/Sao_Paulo)" })).toBe("5h")
  })

  test("non-quota returns null", () => {
    expect(classifyQuotaKind({ message: "some random error" })).toBe(null)
  })
})

describe("parseResetAt", () => {
  test("parses '5pm (America/Sao_Paulo)'", () => {
    const now = new Date("2026-04-17T16:30:00-03:00").getTime() // 19:30 UTC
    const reset = parseResetAt("You've hit your limit · resets 5pm (America/Sao_Paulo)", now)
    expect(reset).not.toBeNull()
    // 5pm São Paulo = 20:00 UTC. Should be today 20:00 UTC.
    const d = new Date(reset!)
    expect(d.getUTCHours()).toBe(20)
    expect(d.getUTCMinutes()).toBe(0)
  })

  test("parses '11am' without tz (uses local)", () => {
    const now = Date.now()
    const reset = parseResetAt("resets at 11am", now)
    expect(reset).not.toBeNull()
    expect(reset! > now).toBe(true)
  })

  test("parses '5:30pm'", () => {
    const now = new Date("2026-04-17T10:00:00-03:00").getTime()
    const reset = parseResetAt("resets 5:30pm (America/Sao_Paulo)", now)
    expect(reset).not.toBeNull()
    const d = new Date(reset!)
    expect(d.getUTCMinutes()).toBe(30)
  })

  test("pushes to tomorrow if time is in the past today", () => {
    const now = new Date("2026-04-17T23:00:00-03:00").getTime() // 11pm
    const reset = parseResetAt("resets 5pm (America/Sao_Paulo)", now)
    expect(reset).not.toBeNull()
    expect(reset! > now).toBe(true)
    expect(reset! - now).toBeLessThan(24 * 60 * 60 * 1000 + 1000)
  })

  test("returns null when no reset pattern present", () => {
    expect(parseResetAt("generic error")).toBeNull()
  })
})

describe("tryRecoverMeridianAuth (refresh-first)", () => {
  type Reg = {
    __meridianReassign?: (sessionID: string, reason?: string) => string | null
    __meridianProfileStatus?: () => {
      profiles: string[]
      cooldowns: Array<{ profile: string; until: number; reason: string }>
      sessionAffinity: number
    }
    __meridianRefreshProfile?: (profile: string) => Promise<boolean>
  }
  const reg = globalThis as unknown as Reg

  beforeEach(() => {
    delete reg.__meridianRefreshProfile
    delete reg.__meridianProfileStatus
    delete reg.__meridianReassign
  })

  afterEach(() => {
    delete reg.__meridianRefreshProfile
    delete reg.__meridianProfileStatus
    delete reg.__meridianReassign
  })

  test("returns 'refreshed' when refresh succeeds on an auth_expired profile", async () => {
    const refreshed: string[] = []
    reg.__meridianProfileStatus = () => ({
      profiles: ["main", "alt4"],
      cooldowns: [{ profile: "alt4", until: Date.now() + 60_000, reason: "auth_expired" }],
      sessionAffinity: 1,
    })
    reg.__meridianRefreshProfile = async (profile: string) => {
      refreshed.push(profile)
      return true
    }
    reg.__meridianReassign = () => {
      throw new Error("should not reassign when refresh succeeds")
    }

    const result = await tryRecoverMeridianAuth("ses_1")
    expect(result.outcome).toBe("refreshed")
    expect(refreshed).toEqual(["alt4"])
  })

  test("falls back to reassign when refresh returns false", async () => {
    reg.__meridianProfileStatus = () => ({
      profiles: ["main", "alt4"],
      cooldowns: [{ profile: "alt4", until: Date.now() + 60_000, reason: "auth_expired" }],
      sessionAffinity: 1,
    })
    reg.__meridianRefreshProfile = async () => false
    reg.__meridianReassign = (_sid, _reason) => "main"

    const result = await tryRecoverMeridianAuth("ses_2")
    expect(result.outcome).toBe("rotated")
    expect(result.profile).toBe("main")
  })

  test("reports no_profile when refresh fails AND no alternate healthy profile", async () => {
    reg.__meridianProfileStatus = () => ({
      profiles: ["main"],
      cooldowns: [{ profile: "main", until: Date.now() + 60_000, reason: "auth_expired" }],
      sessionAffinity: 1,
    })
    reg.__meridianRefreshProfile = async () => false
    reg.__meridianReassign = () => null

    const result = await tryRecoverMeridianAuth("ses_3")
    expect(result.outcome).toBe("no_profile")
    expect(result.profile).toBeNull()
  })

  test("degrades to reassign when plugin registry not wired up (back-compat)", async () => {
    // No refresh/status hooks exposed — older plugin versions
    reg.__meridianReassign = () => "alt4"
    const result = await tryRecoverMeridianAuth("ses_4")
    expect(result.outcome).toBe("rotated")
    expect(result.profile).toBe("alt4")
  })

  test("does not throw if refresh hook throws", async () => {
    reg.__meridianProfileStatus = () => ({
      profiles: ["main"],
      cooldowns: [{ profile: "main", until: Date.now() + 60_000, reason: "auth_expired" }],
      sessionAffinity: 1,
    })
    reg.__meridianRefreshProfile = async () => {
      throw new Error("boom")
    }
    reg.__meridianReassign = () => "main"
    const result = await tryRecoverMeridianAuth("ses_5")
    // refresh threw → fell through to reassign
    expect(result.outcome).toBe("rotated")
  })
})
