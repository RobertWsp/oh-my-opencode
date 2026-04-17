import { describe, expect, test, beforeEach } from "bun:test"
import { createSubagentQuestionNotifierHook } from "./index"

interface ToastCall {
  title: string
  message: string
  variant: string
  duration: number
}

type SessionRecord = { parentID?: string | null }

function makeCtx(
  toastCalls: ToastCall[],
  sessionsByID: Record<string, SessionRecord>,
) {
  return {
    directory: "/tmp/test",
    client: {
      session: {
        get: async (args: { path: { id: string } }) => ({
          data: sessionsByID[args.path.id] ?? {},
        }),
      },
      tui: {
        showToast: async (args: { body: ToastCall }) => {
          toastCalls.push(args.body)
          return {}
        },
      },
    } as unknown as Parameters<typeof createSubagentQuestionNotifierHook>[0]["ctx"]["client"],
  }
}

describe("subagent-question-notifier", () => {
  let toastCalls: ToastCall[]

  beforeEach(() => {
    toastCalls = []
  })

  test("shows toast when subagent (has parentID) asks a question", async () => {
    const ctx = makeCtx(toastCalls, {
      ses_child: { parentID: "ses_parent" },
    })
    const hook = createSubagentQuestionNotifierHook({ ctx })

    await hook.event({
      event: {
        type: "question.asked",
        properties: {
          id: "qst_1",
          sessionID: "ses_child",
          questions: [
            { question: "Which database?", header: "DB" },
          ],
        },
      },
    })

    expect(toastCalls.length).toBe(1)
    expect(toastCalls[0].title).toContain("clarification")
    expect(toastCalls[0].message).toContain("Which database?")
    expect(toastCalls[0].message).toContain("ctrl+x down")
  })

  test("skips when session has no parentID (primary session)", async () => {
    const ctx = makeCtx(toastCalls, {
      ses_primary: { parentID: null },
    })
    const hook = createSubagentQuestionNotifierHook({ ctx })

    await hook.event({
      event: {
        type: "question.asked",
        properties: {
          id: "qst_2",
          sessionID: "ses_primary",
          questions: [{ question: "?", header: "H" }],
        },
      },
    })

    expect(toastCalls.length).toBe(0)
  })

  test("deduplicates notifications by request id", async () => {
    const ctx = makeCtx(toastCalls, {
      ses_child: { parentID: "ses_parent" },
    })
    const hook = createSubagentQuestionNotifierHook({ ctx })

    const evt = {
      type: "question.asked" as const,
      properties: {
        id: "qst_dup",
        sessionID: "ses_child",
        questions: [{ question: "?", header: "H" }],
      },
    }

    await hook.event({ event: evt })
    await hook.event({ event: evt })

    expect(toastCalls.length).toBe(1)
  })

  test("clears dedupe state on question.replied so resumed sessions work", async () => {
    const ctx = makeCtx(toastCalls, {
      ses_child: { parentID: "ses_parent" },
    })
    const hook = createSubagentQuestionNotifierHook({ ctx })

    const asked = {
      type: "question.asked" as const,
      properties: {
        id: "qst_resume",
        sessionID: "ses_child",
        questions: [{ question: "?", header: "H" }],
      },
    }

    await hook.event({ event: asked })
    expect(toastCalls.length).toBe(1)

    await hook.event({
      event: {
        type: "question.replied",
        properties: { id: "qst_resume", requestID: "qst_resume" },
      },
    })

    await hook.event({ event: asked })
    expect(toastCalls.length).toBe(2)
  })

  test("headers with >140 chars are truncated in the toast message", async () => {
    const long = "x".repeat(300)
    const ctx = makeCtx(toastCalls, {
      ses_child: { parentID: "ses_parent" },
    })
    const hook = createSubagentQuestionNotifierHook({ ctx })

    await hook.event({
      event: {
        type: "question.asked",
        properties: {
          id: "qst_long",
          sessionID: "ses_child",
          questions: [{ question: long, header: "H" }],
        },
      },
    })

    expect(toastCalls.length).toBe(1)
    expect(toastCalls[0].message).toContain("...")
    expect(toastCalls[0].message.length).toBeLessThan(long.length + 100)
  })

  test("non-question events are ignored", async () => {
    const ctx = makeCtx(toastCalls, {})
    const hook = createSubagentQuestionNotifierHook({ ctx })

    await hook.event({
      event: { type: "session.error", properties: { sessionID: "x" } },
    })
    expect(toastCalls.length).toBe(0)
  })
})
