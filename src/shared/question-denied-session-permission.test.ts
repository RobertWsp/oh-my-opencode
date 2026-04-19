import { describe, expect, test } from "bun:test"
import {
  QUESTION_DENIED_SESSION_PERMISSION,
  getSubagentSessionPermissions,
} from "./question-denied-session-permission"

describe("getSubagentSessionPermissions", () => {
  test("denies question for non-plan-family agents", () => {
    expect(getSubagentSessionPermissions("explore")).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
    expect(getSubagentSessionPermissions("oracle")).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
    expect(getSubagentSessionPermissions("sisyphus-junior")).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
  })

  test("allows question for plan-family agents (prometheus, plan)", () => {
    const rules = getSubagentSessionPermissions("prometheus")
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({ permission: "question", action: "allow", pattern: "*" })
    expect(getSubagentSessionPermissions("plan")).toEqual(rules)
  })

  test("does NOT return empty array (which fork interprets as 'ask' default, blocking)", () => {
    expect(getSubagentSessionPermissions("prometheus")).not.toEqual([])
    expect(getSubagentSessionPermissions("plan")).not.toEqual([])
  })

  test("handles case and whitespace in agent name", () => {
    const expected = [{ permission: "question", action: "allow", pattern: "*" }]
    expect(getSubagentSessionPermissions("Prometheus")).toEqual(expected)
    expect(getSubagentSessionPermissions("PROMETHEUS")).toEqual(expected)
    expect(getSubagentSessionPermissions(" prometheus ")).toEqual(expected)
  })

  test("resolves runtime display name via getAgentConfigKey (regression)", () => {
    const expected = [{ permission: "question", action: "allow", pattern: "*" }]
    expect(getSubagentSessionPermissions("Prometheus - Plan Builder")).toEqual(expected)
    expect(getSubagentSessionPermissions("\u200B\u200B\u200BPrometheus - Plan Builder")).toEqual(expected)
    expect(getSubagentSessionPermissions("Atlas - Plan Executor")).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
  })
})
