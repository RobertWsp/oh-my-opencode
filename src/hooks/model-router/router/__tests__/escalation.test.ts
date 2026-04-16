import { describe, it, expect } from "bun:test"
import { parseSubagentOutput, shouldHonorEscalation } from "../escalation"

describe("parseSubagentOutput", () => {
  it("parses a well-formed escalation block", () => {
    const text = `<escalation>
reason: found 12 conflicts, far more than estimated
target_tier: opus
evidence: files touched exploded from 2 to 14
condensed_context: already reviewed auth.ts, middleware.ts; pending: rate limiter, cookies
</escalation>`
    const out = parseSubagentOutput(text)
    expect(out.signal?.type).toBe("escalation")
    if (out.signal?.type === "escalation") {
      expect(out.signal.target_tier).toBe("opus")
      expect(out.signal.reason).toContain("12 conflicts")
      expect(out.signal.condensed_context).toContain("rate limiter")
    }
  })

  it("parses an error block", () => {
    const text = `<error>
reason: permission denied on ./deploy/prod
recovery_hint: main session should confirm before retry
</error>`
    const out = parseSubagentOutput(text)
    expect(out.signal?.type).toBe("error")
    if (out.signal?.type === "error") {
      expect(out.signal.reason).toContain("permission denied")
      expect(out.signal.recovery_hint).toContain("main session")
    }
  })

  it("parses a result block", () => {
    const text = `<result>
Committed 3 files to main, pushed successfully.
</result>`
    const out = parseSubagentOutput(text)
    expect(out.signal?.type).toBe("result")
    if (out.signal?.type === "result") expect(out.signal.deliverable).toContain("Committed 3 files")
  })

  it("returns fallback when no protocol block is present", () => {
    const out = parseSubagentOutput("The task completed successfully.")
    expect(out.signal).toBeNull()
  })

  it("defaults target_tier to opus when missing", () => {
    const text = `<escalation>
reason: something went wrong
</escalation>`
    const out = parseSubagentOutput(text)
    if (out.signal?.type === "escalation") expect(out.signal.target_tier).toBe("opus")
  })
})

describe("shouldHonorEscalation", () => {
  it("honors a valid upgrade", () => {
    const res = shouldHonorEscalation({ current: "haiku", requested: "sonnet", previousEscalations: 0 })
    expect(res.honor).toBe(true)
    expect(res.reason).toBe("upgrade_approved")
  })

  it("refuses downgrade", () => {
    const res = shouldHonorEscalation({ current: "opus", requested: "haiku", previousEscalations: 0 })
    expect(res.honor).toBe(false)
    expect(res.reason).toBe("not_an_upgrade")
  })

  it("refuses same-tier request", () => {
    const res = shouldHonorEscalation({ current: "sonnet", requested: "sonnet", previousEscalations: 0 })
    expect(res.honor).toBe(false)
  })

  it("refuses after max escalations", () => {
    const res = shouldHonorEscalation({ current: "sonnet", requested: "opus", previousEscalations: 2 })
    expect(res.honor).toBe(false)
    expect(res.reason).toBe("max_escalations_reached")
  })
})
