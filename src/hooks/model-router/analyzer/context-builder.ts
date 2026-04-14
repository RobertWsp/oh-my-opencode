import { log } from "../../../shared/logger"
import type { PersistedSessionState } from "../storage/session-state-store"

/**
 * Build rich context for the continuation classifier and the analyzer.
 *
 * Inputs:
 *   - Current prompt
 *   - Session state (persisted — tokens, last decision, recent messages)
 *   - Current working directory
 *   - Session messages (if available via ctx.client.session.messages)
 *
 * Outputs a ContextSnapshot with signals the classifier uses:
 *   - recentTopics: summarized list of what the session has been about
 *   - cwdChanged: whether the cwd differs from the last recorded one
 *   - topicShiftLikely: heuristic signal based on prompt vs recent messages
 *   - turnGapMinutes: how long since the last turn (long gap → may be new task)
 */

export interface SessionMessageLike {
  info?: {
    role?: string
    time?: { created?: number }
    model?: { providerID?: string; modelID?: string }
    agent?: string
    path?: { cwd?: string }
  }
  parts?: Array<{ type?: string; text?: string }>
}

export interface ContextSnapshot {
  /** Up to 5 most recent user messages (first ~150 chars each). */
  recentUserMessages: Array<{ text: string; tier?: string; ageMinutes: number }>
  /** Up to 3 most recent assistant summaries (first ~150 chars each). */
  recentAssistantMessages: Array<{ text: string; model?: string; ageMinutes: number }>
  /** Current cwd from the last message (if available). */
  currentCwd: string | null
  /** cwd from the previous session state (for change detection). */
  previousCwd: string | null
  /** Whether the cwd changed since last session. */
  cwdChanged: boolean
  /** Minutes since the last assistant message (null if no history). */
  turnGapMinutes: number | null
  /** Heuristic: jaccard similarity between current prompt and last user message. */
  jaccardWithLast: number | null
  /** Short session summary: "last X turns on topic Y in /path" */
  oneLiner: string
}

/**
 * Interface for the client that can fetch session messages.
 * This is the subset of ctx.client.session.messages that we use.
 */
export interface SessionMessagesClient {
  messages(args: {
    path: { id: string }
    query?: { directory?: string }
  }): Promise<{ data?: SessionMessageLike[] } | SessionMessageLike[] | unknown>
}

/**
 * Fetch messages from OpenCode's session API and return a normalized array.
 */
export async function fetchSessionMessages(
  client: SessionMessagesClient | undefined,
  sessionID: string,
  directory: string | undefined,
): Promise<SessionMessageLike[]> {
  if (!client) return []
  try {
    const resp = await client.messages({
      path: { id: sessionID },
      query: directory ? { directory } : undefined,
    })
    if (Array.isArray(resp)) return resp as SessionMessageLike[]
    if (resp && typeof resp === "object" && "data" in resp) {
      const data = (resp as { data?: unknown }).data
      return Array.isArray(data) ? (data as SessionMessageLike[]) : []
    }
    return []
  } catch (e) {
    log("[model-router] failed to fetch session messages", { error: String(e), sessionID })
    return []
  }
}

function extractText(msg: SessionMessageLike): string {
  const parts = msg.parts ?? []
  const texts = parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.length > 0)
    .map((p) => p.text as string)
  return texts.join("\n").trim()
}

/**
 * Estimate cumulative tokens from the session message history. Used as
 * a fallback when the message.updated tracker is stale (e.g., user
 * interrupted a stream before it finalized). Conservative:
 *   - Counts only text parts (tool results, images ignored → underestimate)
 *   - ~3.5 chars/token heuristic (handles both English and pt-BR OK)
 *   - Always returns a non-negative integer
 */
export function estimateHistoryTokens(messages: SessionMessageLike[]): number {
  let totalChars = 0
  for (const m of messages) {
    const parts = m.parts ?? []
    for (const p of parts) {
      if (p.type === "text" && typeof p.text === "string") {
        totalChars += p.text.length
      }
    }
  }
  return Math.ceil(totalChars / 3.5)
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  )
}

function jaccard(a: string, b: string): number {
  const wa = tokenize(a)
  const wb = tokenize(b)
  if (wa.size === 0 && wb.size === 0) return 1
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  const union = wa.size + wb.size - inter
  return union === 0 ? 0 : inter / union
}

function modelTierLabel(modelID: string | undefined): string | undefined {
  if (!modelID) return undefined
  const id = modelID.toLowerCase()
  if (id.includes("opus")) return "opus"
  if (id.includes("sonnet")) return "sonnet"
  if (id.includes("haiku")) return "haiku"
  return modelID
}

/**
 * Build the context snapshot from session messages + persisted state.
 */
export function buildContextSnapshot(args: {
  currentPrompt: string
  messages: SessionMessageLike[]
  persistedState: PersistedSessionState | null
  currentCwdHint?: string
}): ContextSnapshot {
  const { currentPrompt, messages, persistedState, currentCwdHint } = args
  const now = Date.now()

  // Separate user and assistant messages, keep most recent first
  const userMsgs: Array<{ text: string; tier?: string; ts: number }> = []
  const assistantMsgs: Array<{ text: string; model?: string; ts: number }> = []

  for (const m of messages) {
    const role = m.info?.role
    const ts = m.info?.time?.created ?? 0
    const text = extractText(m)
    if (!text) continue
    if (role === "user") {
      userMsgs.push({ text, ts, tier: modelTierLabel(m.info?.model?.modelID) })
    } else if (role === "assistant") {
      assistantMsgs.push({ text, ts, model: m.info?.model?.modelID })
    }
  }

  userMsgs.sort((a, b) => b.ts - a.ts)
  assistantMsgs.sort((a, b) => b.ts - a.ts)

  // Take the 5 most recent user messages, skip the very last if it's the current one
  // (the current prompt is already included in `currentPrompt`)
  const recentUserMessages = userMsgs
    .slice(0, 6)
    .filter((m) => m.text !== currentPrompt)
    .slice(0, 5)
    .map((m) => ({
      text: m.text.slice(0, 150),
      tier: m.tier,
      ageMinutes: Math.max(0, Math.floor((now - m.ts) / 60_000)),
    }))

  const recentAssistantMessages = assistantMsgs.slice(0, 3).map((m) => ({
    text: m.text.slice(0, 150),
    model: m.model,
    ageMinutes: Math.max(0, Math.floor((now - m.ts) / 60_000)),
  }))

  // Determine current cwd (from most recent message, then hint, then null)
  let currentCwd: string | null = null
  for (const m of messages) {
    const cwd = m.info?.path?.cwd
    if (cwd) {
      currentCwd = cwd
      break
    }
  }
  if (!currentCwd && currentCwdHint) currentCwd = currentCwdHint

  const previousCwd = persistedState?.lastCwd ?? null
  const cwdChanged = Boolean(currentCwd && previousCwd && currentCwd !== previousCwd)

  // Turn gap: minutes since last assistant response
  const turnGapMinutes =
    assistantMsgs.length > 0 && assistantMsgs[0]?.ts
      ? Math.floor((now - assistantMsgs[0].ts) / 60_000)
      : null

  // Jaccard similarity between current prompt and last user message
  const jaccardWithLast =
    recentUserMessages.length > 0 ? jaccard(currentPrompt, recentUserMessages[0]!.text) : null

  // One-liner summary
  const oneLiner = buildOneLiner({
    userCount: userMsgs.length,
    assistantCount: assistantMsgs.length,
    currentCwd,
    cwdChanged,
    turnGapMinutes,
    lastTier: persistedState?.lastDecision?.tier,
  })

  return {
    recentUserMessages,
    recentAssistantMessages,
    currentCwd,
    previousCwd,
    cwdChanged,
    turnGapMinutes,
    jaccardWithLast,
    oneLiner,
  }
}

function buildOneLiner(args: {
  userCount: number
  assistantCount: number
  currentCwd: string | null
  cwdChanged: boolean
  turnGapMinutes: number | null
  lastTier: string | undefined
}): string {
  const parts: string[] = []
  parts.push(`${args.userCount} user + ${args.assistantCount} assistant turns`)
  if (args.currentCwd) parts.push(`cwd=${args.currentCwd.split("/").slice(-2).join("/")}`)
  if (args.cwdChanged) parts.push("cwd-changed")
  if (args.turnGapMinutes !== null) {
    if (args.turnGapMinutes > 60) parts.push(`${Math.floor(args.turnGapMinutes / 60)}h-gap`)
    else if (args.turnGapMinutes > 5) parts.push(`${args.turnGapMinutes}min-gap`)
  }
  if (args.lastTier) parts.push(`last-tier=${args.lastTier}`)
  return parts.join(" · ")
}

/**
 * Render the context snapshot as a compact text block for the LLM prompt.
 */
export function renderContextForPrompt(snapshot: ContextSnapshot): string {
  const lines: string[] = []
  lines.push(`<session_summary>${snapshot.oneLiner}</session_summary>`)

  if (snapshot.recentAssistantMessages.length > 0) {
    lines.push("<recent_assistant_responses>")
    for (const m of snapshot.recentAssistantMessages) {
      const modelTag = m.model ? ` [${modelTierLabel(m.model) ?? m.model}]` : ""
      lines.push(`  ${m.ageMinutes}min ago${modelTag}: ${m.text.slice(0, 120)}`)
    }
    lines.push("</recent_assistant_responses>")
  }

  if (snapshot.recentUserMessages.length > 0) {
    lines.push("<recent_user_messages>")
    for (const m of snapshot.recentUserMessages) {
      const tierTag = m.tier ? ` [${m.tier}]` : ""
      lines.push(`  ${m.ageMinutes}min ago${tierTag}: ${m.text.slice(0, 120)}`)
    }
    lines.push("</recent_user_messages>")
  }

  if (snapshot.cwdChanged) {
    lines.push(`<cwd_change>Working directory changed: ${snapshot.previousCwd} → ${snapshot.currentCwd}</cwd_change>`)
  }

  if (snapshot.jaccardWithLast !== null) {
    lines.push(`<prompt_similarity_with_last>${snapshot.jaccardWithLast.toFixed(2)}</prompt_similarity_with_last>`)
  }

  return lines.join("\n")
}
