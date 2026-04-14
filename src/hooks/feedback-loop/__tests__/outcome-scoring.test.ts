import { describe, expect, test } from "bun:test"
import { emptySignals, scoreOutcome } from "../types"

describe("scoreOutcome", () => {
  test("clean completion → high positive score", () => {
    const s = emptySignals()
    s.completedCleanly = true
    s.toolsExecutedCount = 5
    // no error, no follow-up
    const score = scoreOutcome(s)
    expect(score).toBeGreaterThanOrEqual(0.9)
  })

  test("error → negative score", () => {
    const s = emptySignals()
    s.hasError = true
    const score = scoreOutcome(s)
    expect(score).toBeLessThan(0)
  })

  test("user pinned different model → strong negative", () => {
    const s = emptySignals()
    s.userPinnedDifferentModel = true
    const score = scoreOutcome(s)
    // -0.7 penalty + 0.3 positive (no follow-up) = -0.4 (±float)
    expect(score).toBeLessThanOrEqual(-0.3)
    expect(score).toBeGreaterThanOrEqual(-0.5)
  })

  test("model fallback + correction follow-up → very negative", () => {
    const s = emptySignals()
    s.modelFallbackApplied = true
    s.userFollowedUp = true
    s.followUpCategory = "correction"
    const score = scoreOutcome(s)
    expect(score).toBeLessThanOrEqual(-0.6)
  })

  test("clamps to [-1, 1]", () => {
    const worst = emptySignals()
    worst.hasError = true
    worst.userPinnedDifferentModel = true
    worst.modelFallbackApplied = true
    worst.userFollowedUp = true
    worst.followUpCategory = "correction"
    expect(scoreOutcome(worst)).toBe(-1)

    const best = emptySignals()
    best.completedCleanly = true
    best.toolsExecutedCount = 10
    expect(scoreOutcome(best)).toBeLessThanOrEqual(1)
    expect(scoreOutcome(best)).toBeGreaterThanOrEqual(0.9)
  })

  test("question follow-up has smaller penalty than correction", () => {
    const corrSig = emptySignals()
    corrSig.userFollowedUp = true
    corrSig.followUpCategory = "correction"

    const qSig = emptySignals()
    qSig.userFollowedUp = true
    qSig.followUpCategory = "question"

    expect(scoreOutcome(qSig)).toBeGreaterThan(scoreOutcome(corrSig))
  })
})
