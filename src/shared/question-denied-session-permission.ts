export type SessionPermissionRule = {
  permission: string
  action: "allow" | "deny"
  pattern: string
}

export const QUESTION_DENIED_SESSION_PERMISSION: SessionPermissionRule[] = [
  { permission: "question", action: "deny", pattern: "*" },
]

const PLAN_FAMILY_AGENTS = new Set(["plan", "prometheus"])

function normalizeAgent(agent: string): string {
  return agent.trim().toLowerCase().replace(/^[\s\u200b-\u200f\ufeff]+/, "")
}

export function getSubagentSessionPermissions(agent: string): SessionPermissionRule[] {
  return PLAN_FAMILY_AGENTS.has(normalizeAgent(agent)) ? [] : QUESTION_DENIED_SESSION_PERMISSION
}
