import { getAgentConfigKey } from "./agent-display-names"

export type SessionPermissionRule = {
  permission: string
  action: "allow" | "deny"
  pattern: string
}

export const QUESTION_DENIED_SESSION_PERMISSION: SessionPermissionRule[] = [
  { permission: "question", action: "deny", pattern: "*" },
]

const PLAN_FAMILY_AGENTS = new Set(["plan", "prometheus"])

const QUESTION_ALLOWED_SESSION_PERMISSION: SessionPermissionRule[] = [
  { permission: "question", action: "allow", pattern: "*" },
]

export function getSubagentSessionPermissions(agent: string): SessionPermissionRule[] {
  const configKey = getAgentConfigKey(agent).toLowerCase().trim()
  return PLAN_FAMILY_AGENTS.has(configKey)
    ? QUESTION_ALLOWED_SESSION_PERMISSION
    : QUESTION_DENIED_SESSION_PERMISSION
}
