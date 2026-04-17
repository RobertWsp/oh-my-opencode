import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { isMeridianAuthError, tryReassignMeridianProfile } from "./meridian-auth-recovery"

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
  })
})
