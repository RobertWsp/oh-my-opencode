import type { Tier } from "../types"

/**
 * Parse the subagent's final output for protocol blocks:
 *   <escalation>…</escalation>   — request a more capable model, re-spawn
 *   <error>…</error>             — hard failure with recovery hint
 *   <result>…</result>           — successful deliverable
 *
 * The parser is defensive: it tolerates whitespace, case variations, and
 * extra prose around the blocks. Key:value lines inside <escalation> and
 * <error> are parsed loosely.
 */

export interface EscalationSignal {
  type: "escalation"
  reason: string
  target_tier: Tier
  evidence: string
  condensed_context: string
  raw: string
}

export interface ErrorSignal {
  type: "error"
  reason: string
  recovery_hint: string
  raw: string
}

export interface ResultSignal {
  type: "result"
  deliverable: string
}

export type ParsedSubagentOutput =
  | { signal: EscalationSignal }
  | { signal: ErrorSignal }
  | { signal: ResultSignal }
  | { signal: null; fallbackText: string }

const ESCALATION_RE = /<escalation>([\s\S]*?)<\/escalation>/i
const ERROR_RE = /<error>([\s\S]*?)<\/error>/i
const RESULT_RE = /<result>([\s\S]*?)<\/result>/i

export function parseSubagentOutput(text: string): ParsedSubagentOutput {
  const escalation = ESCALATION_RE.exec(text)
  if (escalation) {
    const body = escalation[1].trim()
    const fields = parseKVBlock(body)
    const target = normalizeTier(fields.target_tier ?? fields.tier ?? "")
    return {
      signal: {
        type: "escalation",
        reason: fields.reason ?? "unspecified",
        target_tier: target ?? "opus",
        evidence: fields.evidence ?? "",
        condensed_context: fields.condensed_context ?? "",
        raw: body,
      },
    }
  }

  const err = ERROR_RE.exec(text)
  if (err) {
    const body = err[1].trim()
    const fields = parseKVBlock(body)
    return {
      signal: {
        type: "error",
        reason: fields.reason ?? "unspecified",
        recovery_hint: fields.recovery_hint ?? "",
        raw: body,
      },
    }
  }

  const result = RESULT_RE.exec(text)
  if (result) {
    return {
      signal: {
        type: "result",
        deliverable: result[1].trim(),
      },
    }
  }

  return { signal: null, fallbackText: text }
}

function parseKVBlock(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = body.split(/\r?\n/)
  let currentKey: string | null = null
  const buffers: Record<string, string[]> = {}

  for (const line of lines) {
    const kv = /^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) {
      currentKey = kv[1].toLowerCase()
      buffers[currentKey] = buffers[currentKey] ?? []
      if (kv[2].length > 0) buffers[currentKey].push(kv[2])
    } else if (currentKey && line.trim().length > 0) {
      buffers[currentKey].push(line.trim())
    }
  }

  for (const k of Object.keys(buffers)) {
    out[k] = buffers[k].join("\n").trim()
  }
  return out
}

function normalizeTier(raw: string): Tier | null {
  const s = raw.trim().toLowerCase()
  if (s === "haiku" || s === "sonnet" || s === "opus" || s === "opus-plan") return s
  return null
}

/**
 * Decide whether an escalation should be honored. Guards against infinite
 * upgrade loops and downgrades-disguised-as-escalations.
 */
export function shouldHonorEscalation(args: {
  current: Tier
  requested: Tier
  previousEscalations: number
}): { honor: boolean; reason: string } {
  if (args.previousEscalations >= 2) {
    return { honor: false, reason: "max_escalations_reached" }
  }
  const rank: Record<Tier, number> = { haiku: 1, sonnet: 2, "opus-plan": 3, opus: 3 }
  if (rank[args.requested] <= rank[args.current]) {
    return { honor: false, reason: "not_an_upgrade" }
  }
  return { honor: true, reason: "upgrade_approved" }
}
