import { describe, it, expect } from "bun:test"
import { detectEscalation, buildEscalationRetryInstruction } from "../escalation-loop"

const ESCALATION_OUTPUT = `
task_id: ses_sub_xyz

<task_result>
<escalation>
reason: discovered 12 conflicts spanning 14 files (estimated 2)
target_tier: opus
evidence: git status shows 14 files in conflict, 12 with non-trivial diffs
condensed_context: read auth.ts, middleware/cors.ts; pending: rate-limiter, cookies
</escalation>
</task_result>
`

const RESULT_OUTPUT = `
task_id: ses_sub_abc

<task_result>
<result>
Committed 3 files and pushed to main.
</result>
</task_result>
`

describe("detectEscalation", () => {
  it("detects an escalation block embedded inside task_result", () => {
    const det = detectEscalation({
      subagentOutput: ESCALATION_OUTPUT,
      currentTier: "haiku",
      previousEscalations: 0,
    })
    expect(det.detected).toBe(true)
    if (det.detected) {
      expect(det.toTier).toBe("opus")
      expect(det.honor).toBe(true)
      expect(det.fromTier).toBe("haiku")
      expect(det.reason).toContain("12 conflicts")
    }
  })

  it("returns no escalation for clean result output", () => {
    const det = detectEscalation({
      subagentOutput: RESULT_OUTPUT,
      currentTier: "haiku",
      previousEscalations: 0,
    })
    expect(det.detected).toBe(false)
  })

  it("flags honor=false when previousEscalations exceeds limit", () => {
    const det = detectEscalation({
      subagentOutput: ESCALATION_OUTPUT,
      currentTier: "sonnet",
      previousEscalations: 2,
    })
    expect(det.detected).toBe(true)
    if (det.detected) expect(det.honor).toBe(false)
  })

  it("flags honor=false when escalation is a downgrade", () => {
    const downgrade = ESCALATION_OUTPUT.replace("target_tier: opus", "target_tier: haiku")
    const det = detectEscalation({
      subagentOutput: downgrade,
      currentTier: "sonnet",
      previousEscalations: 0,
    })
    if (det.detected) expect(det.honor).toBe(false)
  })
})

describe("buildEscalationRetryInstruction", () => {
  it("includes the upgraded tier as fork enum", () => {
    const out = buildEscalationRetryInstruction({
      target: "opus",
      reason: "complexity higher than estimated",
      condensed: "files A, B reviewed",
      evidence: "git status shows 14 files",
    })
    expect(out).toContain(`tier: "quality"`)
    expect(out).toContain("escalation retry")
  })

  it("includes evidence and condensed context blocks", () => {
    const out = buildEscalationRetryInstruction({
      target: "sonnet",
      reason: "tool failed twice",
      condensed: "step 1 done, step 2 failed",
      evidence: "two consecutive errors",
    })
    expect(out).toContain("two consecutive errors")
    expect(out).toContain("step 1 done")
    expect(out).toContain(`tier: "balanced"`)
  })
})
