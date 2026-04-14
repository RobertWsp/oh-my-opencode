import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { log } from "../../../shared/logger"
import type { RoutingDecision, RoutingOutcome } from "../types"

/**
 * Append-only JSONL log of routing decisions. Each decision is one line.
 * The feedback-loop hook later enriches entries by rewriting the file
 * only at session end (cheap because we use a per-session in-memory batch
 * and flush once on session.idle).
 *
 * We deliberately do NOT read-modify-write every entry — that would be
 * O(log size) per decision. Instead, the log is append-only and outcomes
 * are appended as separate records keyed by { sessionID, timestamp }.
 * Stats queries aggregate both record types.
 */

type DecisionRecord = {
  kind: "decision"
  ts: number
  data: RoutingDecision
}

type OutcomeRecord = {
  kind: "outcome"
  ts: number
  sessionID: string
  decisionTs: number // matches the decision's timestamp for joining
  data: RoutingOutcome
}

type LogRecord = DecisionRecord | OutcomeRecord

/**
 * Append a routing decision to the log. Non-blocking: errors are logged
 * but never thrown (this is observability, not business logic).
 */
export async function appendDecision(path: string, decision: RoutingDecision): Promise<void> {
  const record: DecisionRecord = {
    kind: "decision",
    ts: decision.timestamp,
    data: decision,
  }
  await appendLine(path, record)
}

/**
 * Append an outcome record for a previously-logged decision.
 */
export async function appendOutcome(
  path: string,
  sessionID: string,
  decisionTs: number,
  outcome: RoutingOutcome,
): Promise<void> {
  const record: OutcomeRecord = {
    kind: "outcome",
    ts: Date.now(),
    sessionID,
    decisionTs,
    data: outcome,
  }
  await appendLine(path, record)
}

async function appendLine(path: string, record: LogRecord): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(record) + "\n", { encoding: "utf-8" })
  } catch (e) {
    log("[model-router] decision log write failed", { error: String(e), path })
  }
}
