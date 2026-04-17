import type { PluginInput } from "@opencode-ai/plugin"
import { log } from "../../shared/logger"

/**
 * Subagent question notifier
 *
 * When a subagent (any agent running with a parentID) emits a
 * question.asked event, the QuestionTool already renders the prompt
 * inside that subagent's session view — but the user is usually
 * focused on the parent session and won't notice. This hook raises a
 * TUI toast on every question.asked whose session has a parentID,
 * telling the user to navigate to the subagent view (ctrl+x down).
 *
 * Without this, subagent questions sit silent in a session the user
 * has to manually discover — which is exactly what was happening
 * with Prometheus Interview Mode appearing as "0 toolcalls" to users.
 */

const HOOK_NAME = "subagent-question-notifier"

export interface SubagentQuestionNotifierContext {
  directory: string
  client: PluginInput["client"]
}

export interface SubagentQuestionNotifierOptions {
  ctx: SubagentQuestionNotifierContext
}

interface QuestionInfo {
  header?: string
  question?: string
}

interface QuestionAskedProps {
  id?: string
  sessionID?: string
  questions?: QuestionInfo[]
}

export function createSubagentQuestionNotifierHook(
  options: SubagentQuestionNotifierOptions,
) {
  const notifiedRequests = new Set<string>()

  const isSubagent = async (sessionID: string): Promise<boolean> => {
    try {
      const result = await options.ctx.client.session.get({
        path: { id: sessionID },
        query: { directory: options.ctx.directory },
      })
      const data = (result as { data?: { parentID?: string | null } }).data
      return typeof data?.parentID === "string" && data.parentID.length > 0
    } catch (error) {
      log(`[${HOOK_NAME}] failed to resolve session parent`, {
        sessionID,
        error: String(error),
      })
      return false
    }
  }

  const showQuestionToast = async (
    sessionID: string,
    questions: QuestionInfo[],
  ): Promise<void> => {
    const tui = options.ctx.client.tui as unknown as {
      showToast?: (input: {
        body: { title: string; message: string; variant: string; duration: number }
      }) => Promise<unknown>
    }
    if (!tui?.showToast) return

    const preview = questions[0]?.question ?? questions[0]?.header ?? "pending clarification"
    const truncated = preview.length > 140 ? preview.slice(0, 137) + "..." : preview
    const count = questions.length
    const title =
      count > 1
        ? `Subagent has ${count} questions`
        : "Subagent needs clarification"

    await tui
      .showToast({
        body: {
          title,
          message: `${truncated}\n\n→ ctrl+x down to open the subagent view and answer.`,
          variant: "info",
          duration: 15_000,
        },
      })
      .catch((error) => {
        log(`[${HOOK_NAME}] showToast failed`, { sessionID, error: String(error) })
      })
  }

  const eventHandler = async ({
    event,
  }: {
    event: { type: string; properties?: unknown }
  }): Promise<void> => {
    if (event.type !== "question.asked") return

    const props = event.properties as QuestionAskedProps | undefined
    if (!props) return

    const sessionID = props.sessionID
    const requestID = props.id
    if (!sessionID || !requestID) return

    if (notifiedRequests.has(requestID)) return
    notifiedRequests.add(requestID)

    const questions = Array.isArray(props.questions) ? props.questions : []
    if (questions.length === 0) return

    const subagent = await isSubagent(sessionID)
    if (!subagent) return

    log(`[${HOOK_NAME}] notifying about subagent question`, {
      sessionID,
      requestID,
      count: questions.length,
    })
    await showQuestionToast(sessionID, questions)
  }

  const clearRequest = (requestID: string | undefined): void => {
    if (!requestID) return
    notifiedRequests.delete(requestID)
  }

  const cleanupHandler = async ({
    event,
  }: {
    event: { type: string; properties?: unknown }
  }): Promise<void> => {
    if (event.type !== "question.replied" && event.type !== "question.rejected") return
    const props = event.properties as { id?: string; requestID?: string } | undefined
    clearRequest(props?.id)
    clearRequest(props?.requestID)
  }

  return {
    event: async (input: { event: { type: string; properties?: unknown } }) => {
      await eventHandler(input)
      await cleanupHandler(input)
    },
  }
}
