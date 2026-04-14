import { describe, expect, test } from "bun:test"
import { detectStructuredPrompt } from "../analyzer/structured-prompt"

describe("detectStructuredPrompt", () => {
  test("detects CONTEXT/GOAL markers from real OpenCode usage", () => {
    const prompt = `[CONTEXT]: I'm reviewing the CRM calendar code.
[GOAL]: Find all calendar-related files.
[REQUEST]: List them.`
    const signal = detectStructuredPrompt(prompt)
    expect(signal.isStructured).toBe(true)
    expect(signal.markers.length).toBeGreaterThanOrEqual(3)
    expect(signal.detailLevel).toBe("detailed")
  })

  test("detects markdown ## TASK structure", () => {
    const prompt = `## TASK
Implement the user authentication.

## EXPECTED OUTCOME
- Login works
- Logout works

## REQUIRED TOOLS
Read, Edit, Bash`
    const signal = detectStructuredPrompt(prompt)
    expect(signal.isStructured).toBe(true)
    expect(signal.markers.length).toBeGreaterThanOrEqual(3)
  })

  test("unstructured prompt → not structured", () => {
    const prompt = "fix the typo in README"
    const signal = detectStructuredPrompt(prompt)
    expect(signal.isStructured).toBe(false)
    expect(signal.detailLevel).toBe("none")
  })

  test("single marker → basic", () => {
    const prompt = `[CONTEXT]: Bug in login page.
Fix it.`
    const signal = detectStructuredPrompt(prompt)
    expect(signal.markers.length).toBe(1)
    expect(signal.detailLevel).toBe("basic")
    expect(signal.isStructured).toBe(false)
  })

  test("long multi-section prompt → comprehensive", () => {
    const prompt = `## 1. TASK
Implement a complete payment flow with Stripe integration including webhooks, refunds, and reconciliation.

## 2. EXPECTED OUTCOME
- [ ] Customer creation API
- [ ] Payment intent creation
- [ ] Webhook handler for payment_intent.succeeded
- [ ] Webhook handler for charge.refunded
- [ ] Reconciliation script that runs daily
- [ ] Tests for all the above

## 3. REQUIRED TOOLS
Read, Edit, Bash, WebFetch

## 4. MUST DO
- Use Stripe's idempotency keys
- Store webhook events in DB for audit
- Handle split payments`
    const signal = detectStructuredPrompt(prompt)
    expect(signal.isStructured).toBe(true)
    expect(signal.detailLevel).toBe("comprehensive")
    expect(signal.markers.length).toBeGreaterThanOrEqual(4)
  })

  test("checkbox list is a signal", () => {
    const prompt = `TODO:
- [ ] Fix bug 1
- [ ] Fix bug 2`
    const signal = detectStructuredPrompt(prompt)
    // Has checkbox pattern → counts as 1 marker
    expect(signal.markers.length).toBeGreaterThanOrEqual(1)
  })
})
