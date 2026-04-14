import { describe, expect, test } from "bun:test"
import {
  activeSessionLocks,
  clearSessionLock,
  withSessionLock,
} from "../session-mutex"

describe("session-mutex", () => {
  test("serializes calls for the same session", async () => {
    const order: string[] = []
    const slow = (label: string, ms: number) =>
      withSessionLock("s1", async () => {
        order.push(`start:${label}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end:${label}`)
        return label
      })

    // Fire three in parallel — they should complete sequentially
    const p1 = slow("A", 30)
    const p2 = slow("B", 10)
    const p3 = slow("C", 5)
    await Promise.all([p1, p2, p3])

    expect(order).toEqual([
      "start:A",
      "end:A",
      "start:B",
      "end:B",
      "start:C",
      "end:C",
    ])
  })

  test("different sessions run in parallel", async () => {
    const order: string[] = []
    const slow = (session: string, label: string, ms: number) =>
      withSessionLock(session, async () => {
        order.push(`start:${label}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end:${label}`)
      })

    const p1 = slow("sA", "A", 30)
    const p2 = slow("sB", "B", 5)
    await Promise.all([p1, p2])

    // B finishes first even though A started first
    expect(order.indexOf("end:B")).toBeLessThan(order.indexOf("end:A"))
  })

  test("error in one call doesn't block the queue", async () => {
    let bRan = false

    const pA = withSessionLock("s2", async () => {
      throw new Error("boom")
    }).catch(() => "swallowed")

    const pB = withSessionLock("s2", async () => {
      bRan = true
      return "B"
    })

    await pA
    const result = await pB
    expect(bRan).toBe(true)
    expect(result).toBe("B")
  })

  test("returns the function's value", async () => {
    const v = await withSessionLock("s3", async () => 42)
    expect(v).toBe(42)
  })

  test("clearSessionLock is a no-op for unknown session", () => {
    // Should not throw
    clearSessionLock("nonexistent")
    expect(activeSessionLocks()).toBeGreaterThanOrEqual(0)
  })

  test("activeSessionLocks reports count", async () => {
    // Kick off a long-running lock
    let release: () => void = () => {}
    const p = withSessionLock("s-active", async () => {
      await new Promise<void>((r) => {
        release = r
      })
    })

    // Give the microtask a tick
    await new Promise((r) => setTimeout(r, 0))
    expect(activeSessionLocks()).toBeGreaterThan(0)

    release()
    await p
  })
})
