import type { BackgroundManager } from "../../features/background-agent"
import { getMainSessionID, getSessionAgent } from "../../features/claude-code-session-state"
import { getTaskToastManager } from "../../features/task-toast-manager"
import { log } from "../../shared/logger"
import { createInternalAgentTextPart, resolveInheritedPromptTools } from "../../shared"
import { isAbortError } from "../../shared/is-abort-error"
import {
  buildReminder,
  extractMessages,
  getMessageInfo,
  getMessageParts,
  isUnstableTask,
  THINKING_SUMMARY_MAX_CHARS,
} from "./task-message-analyzer"

const HOOK_NAME = "unstable-agent-babysitter"
const DEFAULT_TIMEOUT_MS = 120000
const COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_STALL_ABORT_AFTER_MS = 180000

type StallEscalationConfig = {
  enabled?: boolean
  abortAfterMs?: number
  notify?: boolean
}

type BabysittingConfig = {
  timeout_ms?: number
  stallEscalation?: StallEscalationConfig
}

type BabysitterContext = {
  directory: string
  client: {
    session: {
      messages: (args: { path: { id: string } }) => Promise<{ data?: unknown } | unknown[]>
      prompt: (args: {
        path: { id: string }
        body: {
          parts: Array<{ type: "text"; text: string }>
          agent?: string
          variant?: string
          model?: { providerID: string; modelID: string }
          tools?: Record<string, boolean>
        }
        query?: { directory?: string }
      }) => Promise<unknown>
      promptAsync: (args: {
        path: { id: string }
        body: {
          parts: Array<{ type: "text"; text: string }>
          agent?: string
          variant?: string
          model?: { providerID: string; modelID: string }
          tools?: Record<string, boolean>
        }
        query?: { directory?: string }
      }) => Promise<unknown>
    }
  }
}

type BabysitterOptions = {
  backgroundManager: Pick<BackgroundManager, "getTasksByParentSession" | "cancelTask">
  config?: BabysittingConfig
}


async function resolveMainSessionTarget(
  ctx: BabysitterContext,
  sessionID: string
): Promise<{ agent?: string; model?: { providerID: string; modelID: string; variant?: string }; tools?: Record<string, boolean> }> {
  let agent = getSessionAgent(sessionID)
  let model: { providerID: string; modelID: string; variant?: string } | undefined
  let tools: Record<string, boolean> | undefined

  try {
    const messagesResp = await ctx.client.session.messages({
      path: { id: sessionID },
    })
    const messages = extractMessages(messagesResp)
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = getMessageInfo(messages[i])
      if (info?.agent || info?.model || (info?.providerID && info?.modelID)) {
        agent = agent ?? info?.agent
        model = info?.model ?? (info?.providerID && info?.modelID ? { providerID: info.providerID, modelID: info.modelID } : undefined)
        tools = resolveInheritedPromptTools(sessionID, info?.tools) ?? tools
        break
      }
    }
  } catch (error) {
    log(`[${HOOK_NAME}] Failed to resolve main session agent`, { sessionID, error: String(error) })
  }

  return { agent, model, tools: resolveInheritedPromptTools(sessionID, tools) }
}

async function getThinkingSummary(ctx: BabysitterContext, sessionID: string): Promise<string | null> {
  try {
    const messagesResp = await ctx.client.session.messages({
      path: { id: sessionID },
    })
    const messages = extractMessages(messagesResp)
    const chunks: string[] = []

    for (const message of messages) {
      const info = getMessageInfo(message)
      if (info?.role !== "assistant") continue
      const parts = getMessageParts(message)
      for (const part of parts) {
        if (part.type === "thinking" && part.thinking) {
          chunks.push(part.thinking)
        }
        if (part.type === "reasoning" && part.text) {
          chunks.push(part.text)
        }
      }
    }

    const combined = chunks.join("\n").trim()
    if (!combined) return null
    if (combined.length <= THINKING_SUMMARY_MAX_CHARS) return combined
    return combined.slice(0, THINKING_SUMMARY_MAX_CHARS) + "..."
  } catch (error) {
    log(`[${HOOK_NAME}] Failed to fetch thinking summary`, { sessionID, error: String(error) })
    return null
  }
}

export function createUnstableAgentBabysitterHook(ctx: BabysitterContext, options: BabysitterOptions) {
  const reminderCooldowns = new Map<string, number>()
  const cancelledSessions = new Set<string>()
  // Stall escalation state: tracks tasks that received a reminder and are
  // being watched for continued silence. Cleared on any task activity.
  const stallWatchers = new Map<string, { reminderAt: number; lastActivityAt: number }>()

  const stallCfg = options.config?.stallEscalation
  const stallEnabled = stallCfg?.enabled !== false
  const stallAbortAfterMs = Math.max(stallCfg?.abortAfterMs ?? DEFAULT_STALL_ABORT_AFTER_MS, 30000)
  const stallNotify = stallCfg?.notify !== false

  const clearStallWatcher = (taskId: string): void => {
    stallWatchers.delete(taskId)
  }

  const markStallActivity = (taskId: string): void => {
    const watcher = stallWatchers.get(taskId)
    if (!watcher) return
    watcher.lastActivityAt = Date.now()
  }

  const showStallToast = (task: { id: string; description: string }): void => {
    if (!stallNotify) return
    try {
      const toastManager = getTaskToastManager() as unknown as {
        client?: { tui?: { showToast?: (opts: { body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown> } }
      } | null
      const tui = toastManager?.client?.tui
      if (!tui?.showToast) return
      tui.showToast({
        body: {
          title: "Subagent stalled — aborted",
          message: `Task "${task.description.slice(0, 80)}" did not respond after reminder. It has been aborted.`,
          variant: "warning",
          duration: 10000,
        },
      }).catch((error: unknown) => {
        log(`[${HOOK_NAME}] Stall toast failed`, { taskId: task.id, error: String(error) })
      })
    } catch (error) {
      log(`[${HOOK_NAME}] Stall toast error`, { taskId: task.id, error: String(error) })
    }
  }

  const escalateIfStalled = async (task: { id: string; description: string }): Promise<void> => {
    const watcher = stallWatchers.get(task.id)
    if (!watcher) return

    const now = Date.now()
    const silentSince = Math.max(watcher.reminderAt, watcher.lastActivityAt)
    const silentMs = now - silentSince
    if (silentMs < stallAbortAfterMs) return

    stallWatchers.delete(task.id)
    log(`[${HOOK_NAME}] Stall escalation: aborting task`, {
      taskId: task.id,
      silentMs,
      abortAfterMs: stallAbortAfterMs,
    })

    showStallToast(task)

    try {
      await options.backgroundManager.cancelTask(task.id, {
        source: "stall-escalation",
        reason: "No activity after babysitter reminder",
        abortSession: true,
      })
    } catch (error) {
      log(`[${HOOK_NAME}] Stall escalation abort failed`, { taskId: task.id, error: String(error) })
    }
  }

  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.error") {
      const sessionID = props?.sessionID as string | undefined
      if (!sessionID || !isAbortError(props?.error)) return

      cancelledSessions.add(sessionID)
      reminderCooldowns.clear()
      log(`[${HOOK_NAME}] Marked session cancelled`, { sessionID })
      return
    }

    if (event.type === "session.stop") {
      const sessionID = props?.sessionID as string | undefined
      if (!sessionID) return

      cancelledSessions.add(sessionID)
      reminderCooldowns.clear()
      log(`[${HOOK_NAME}] Marked session cancelled via session.stop`, { sessionID })
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info as Record<string, unknown> | undefined
      const sessionID = info?.sessionID as string | undefined
      const role = info?.role as string | undefined
      if (!sessionID || (role !== "user" && role !== "assistant")) return

      cancelledSessions.delete(sessionID)
      // Task activity detected — reset stall watchers for any task with this session
      for (const [taskId, watcher] of stallWatchers) {
        if (watcher) markStallActivity(taskId)
      }
      return
    }

    if (event.type === "tool.execute.before" || event.type === "tool.execute.after") {
      const sessionID = props?.sessionID as string | undefined
      if (!sessionID) return

      cancelledSessions.delete(sessionID)
      // Tool activity — reset stall watcher for any task in this session
      for (const [taskId, watcher] of stallWatchers) {
        if (watcher) markStallActivity(taskId)
      }
      return
    }

    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined
      if (!sessionInfo?.id) return

      cancelledSessions.delete(sessionInfo.id)
      return
    }

    if (event.type !== "session.idle") return

    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    const mainSessionID = getMainSessionID()
    if (!mainSessionID || sessionID !== mainSessionID) return

    if (cancelledSessions.has(mainSessionID)) {
      log(`[${HOOK_NAME}] Skipped reminder: session was cancelled`, { sessionID: mainSessionID })
      return
    }

    const tasks = options.backgroundManager.getTasksByParentSession(mainSessionID)
    if (tasks.length === 0) return

    const timeoutMs = options.config?.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const now = Date.now()

    for (const task of tasks) {
      if (task.status !== "running") {
        // Task is done (completed/cancelled/error) — drop any watcher
        clearStallWatcher(task.id)
        continue
      }
      if (!isUnstableTask(task)) continue

      // If this task has an active stall watcher, check for escalation first.
      if (stallEnabled && stallWatchers.has(task.id)) {
        await escalateIfStalled({ id: task.id, description: task.description })
      }

      const lastMessageAt = task.progress?.lastMessageAt
      if (!lastMessageAt) continue

      const idleMs = now - lastMessageAt.getTime()
      if (idleMs < timeoutMs) continue

      const lastReminderAt = reminderCooldowns.get(task.id)
      if (lastReminderAt && now - lastReminderAt < COOLDOWN_MS) continue

      const summary = task.sessionID ? await getThinkingSummary(ctx, task.sessionID) : null
      const reminder = buildReminder(task, summary, idleMs)
      const { agent, model, tools } = await resolveMainSessionTarget(ctx, mainSessionID)

      try {
        const launchModel = model
          ? { providerID: model.providerID, modelID: model.modelID }
          : undefined
        const launchVariant = model?.variant

        await ctx.client.session.promptAsync({
          path: { id: mainSessionID },
          body: {
            ...(agent ? { agent } : {}),
            ...(launchModel ? { model: launchModel } : {}),
            ...(launchVariant ? { variant: launchVariant } : {}),
            ...(tools ? { tools } : {}),
            parts: [createInternalAgentTextPart(reminder)],
          },
          query: { directory: ctx.directory },
        })
        reminderCooldowns.set(task.id, now)
        log(`[${HOOK_NAME}] Reminder injected`, { taskId: task.id, sessionID: mainSessionID })
        if (stallEnabled) {
          stallWatchers.set(task.id, { reminderAt: now, lastActivityAt: now })
          log(`[${HOOK_NAME}] Stall watcher armed`, {
            taskId: task.id,
            abortAfterMs: stallAbortAfterMs,
          })
        }
      } catch (error) {
        log(`[${HOOK_NAME}] Reminder injection failed`, { taskId: task.id, error: String(error) })
      }
    }
  }

  return {
    event: eventHandler,
  }
}
