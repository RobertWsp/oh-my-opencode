import { describe, expect, test } from "bun:test"
import { DecisionCache } from "../storage/decision-cache"
import type { RoutingDecision } from "../types"

function mkDecision(tier: "haiku" | "sonnet" | "opus" | "opus-plan", sessionID = "s1"): RoutingDecision {
  return {
    timestamp: Date.now(),
    sessionID,
    turnNumber: 1,
    agent: "build",
    tier,
    modelID: `model-${tier}`,
    providerID: "anthropic",
    reasons: [`${tier}:test`],
    analysis: null,
    analyzer: { used: false, durationMs: 0, model: "", fallbackUsed: false, cached: false },
    confidence: 0.9,
  }
}

describe("DecisionCache", () => {
  test("hashPrompt produces consistent keys for same input", () => {
    const a = DecisionCache.hashPrompt("  hello WORLD  ", "build")
    const b = DecisionCache.hashPrompt("hello world", "build")
    expect(a).toBe(b)
  })

  test("hashPrompt differs for different agents", () => {
    const a = DecisionCache.hashPrompt("hello", "build")
    const b = DecisionCache.hashPrompt("hello", "explore")
    expect(a).not.toBe(b)
  })

  test("set/get roundtrip", () => {
    const cache = new DecisionCache({ maxEntries: 10, ttlMs: 60_000 })
    const d = mkDecision("haiku")
    cache.set("k1", d)
    expect(cache.get("k1")).toEqual(d)
  })

  test("returns undefined for missing key", () => {
    const cache = new DecisionCache({ maxEntries: 10, ttlMs: 60_000 })
    expect(cache.get("nope")).toBeUndefined()
  })

  test("expires entries past TTL", async () => {
    const cache = new DecisionCache({ maxEntries: 10, ttlMs: 50 })
    cache.set("k1", mkDecision("haiku"))
    expect(cache.get("k1")).toBeDefined()
    await new Promise((r) => setTimeout(r, 80))
    expect(cache.get("k1")).toBeUndefined()
  })

  test("LRU eviction when full", () => {
    const cache = new DecisionCache({ maxEntries: 3, ttlMs: 60_000 })
    cache.set("k1", mkDecision("haiku"))
    cache.set("k2", mkDecision("sonnet"))
    cache.set("k3", mkDecision("opus"))
    expect(cache.size()).toBe(3)
    // Touch k1 to keep it recent
    cache.get("k1")
    cache.set("k4", mkDecision("opus-plan"))
    expect(cache.size()).toBe(3)
    // k2 was oldest (k1 was touched), so k2 should be evicted
    expect(cache.get("k2")).toBeUndefined()
    expect(cache.get("k1")).toBeDefined()
    expect(cache.get("k3")).toBeDefined()
    expect(cache.get("k4")).toBeDefined()
  })

  test("tracks hit count", () => {
    const cache = new DecisionCache({ maxEntries: 10, ttlMs: 60_000 })
    cache.set("k1", mkDecision("haiku"))
    cache.get("k1")
    cache.get("k1")
    cache.get("k1")
    expect(cache.totalHits()).toBe(3)
  })

  test("clear empties the cache", () => {
    const cache = new DecisionCache({ maxEntries: 10, ttlMs: 60_000 })
    cache.set("k1", mkDecision("haiku"))
    cache.set("k2", mkDecision("sonnet"))
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(cache.get("k1")).toBeUndefined()
  })
})
