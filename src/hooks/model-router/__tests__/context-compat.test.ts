import { describe, expect, test } from "bun:test"
import { checkContextCompatibility, pickCompatibleTier } from "../router/context-compat"

/**
 * Context-compatibility guard tests.
 *
 * Effective limits under Claude Max:
 *   opus / opus-plan = 1,000,000 tokens
 *   sonnet / haiku   =   200,000 tokens
 * Safety margin = 0.85 → usable:
 *   opus = 850,000
 *   sonnet / haiku = 170,000
 */

describe("checkContextCompatibility", () => {
  test("empty context fits everywhere", () => {
    expect(checkContextCompatibility("haiku", 0).compatible).toBe(true)
    expect(checkContextCompatibility("sonnet", 0).compatible).toBe(true)
    expect(checkContextCompatibility("opus", 0).compatible).toBe(true)
  })

  test("150k tokens fit in sonnet", () => {
    const r = checkContextCompatibility("sonnet", 150_000)
    expect(r.compatible).toBe(true)
    expect(r.usableLimit).toBe(170_000)
  })

  test("180k tokens DO NOT fit in sonnet (>170k usable)", () => {
    const r = checkContextCompatibility("sonnet", 180_000)
    expect(r.compatible).toBe(false)
    expect(r.reason).toContain("INCOMPATIBLE")
  })

  test("180k tokens DO NOT fit in haiku either", () => {
    const r = checkContextCompatibility("haiku", 180_000)
    expect(r.compatible).toBe(false)
  })

  test("180k tokens fit in opus (850k usable)", () => {
    const r = checkContextCompatibility("opus", 180_000)
    expect(r.compatible).toBe(true)
  })

  test("700k tokens fit in opus", () => {
    const r = checkContextCompatibility("opus", 700_000)
    expect(r.compatible).toBe(true)
  })

  test("900k tokens DO NOT fit anywhere (above opus 850k usable)", () => {
    expect(checkContextCompatibility("opus", 900_000).compatible).toBe(false)
  })
})

describe("pickCompatibleTier", () => {
  test("sonnet downgrade rejected when 700k tokens in context → upgrade to opus", () => {
    expect(pickCompatibleTier("sonnet", 700_000)).toBe("opus")
  })

  test("haiku downgrade rejected when 300k tokens → upgrade to opus", () => {
    expect(pickCompatibleTier("haiku", 300_000)).toBe("opus")
  })

  test("sonnet choice with 50k tokens → stays sonnet", () => {
    expect(pickCompatibleTier("sonnet", 50_000)).toBe("sonnet")
  })

  test("opus choice with 50k tokens → stays opus", () => {
    expect(pickCompatibleTier("opus", 50_000)).toBe("opus")
  })

  test("opus-plan downgrade rejected when 400k → stays opus-plan (still fits in opus 1M)", () => {
    // opus-plan is treated as opus for context purposes (1M effective)
    expect(pickCompatibleTier("opus-plan", 400_000)).toBe("opus-plan")
  })

  test("900k tokens — nothing fits, returns null", () => {
    expect(pickCompatibleTier("sonnet", 900_000)).toBe(null)
    expect(pickCompatibleTier("opus", 900_000)).toBe(null)
  })
})
