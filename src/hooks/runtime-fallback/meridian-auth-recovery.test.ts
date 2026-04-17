import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  isMeridianAuthError,
  isMeridianQuotaError,
  tryReassignMeridianProfile,
  tryReassignMeridianProfileWithReason,
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
