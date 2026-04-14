import { createHash } from "node:crypto"
import type { CacheEntry, RoutingDecision } from "../types"

/**
 * LRU cache of router decisions keyed by prompt hash. Avoids re-running
 * the analyzer for identical prompts within the TTL window.
 *
 * Simple LRU: uses Map insertion order, promotes on get, evicts oldest
 * when full.
 */

export interface DecisionCacheOptions {
  maxEntries: number
  ttlMs: number
}

export class DecisionCache {
  private entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(opts: DecisionCacheOptions) {
    this.maxEntries = opts.maxEntries
    this.ttlMs = opts.ttlMs
  }

  /**
   * Hash a prompt into a stable cache key. Uses SHA-256 truncated.
   * Lowercased + whitespace-collapsed to match variants of the same text.
   *
   * Context-aware: the cache key includes the context load bucket and the
   * current tier label. This prevents the following bug:
   *
   *   Turn 1 (fresh):   "implementa X" → cached as sonnet
   *   Turn 50 (heavy):  "implementa X" → cache hit → sonnet
   *                                      (wrong! heavy ctx needs opus)
   *
   * By hashing (prompt, agent, contextLoad, currentTier) together, the
   * same prompt in a different session state produces a different key
   * and re-runs the analyzer.
   */
  static hashPrompt(
    promptText: string,
    agent: string,
    contextLoad: string = "unknown",
    currentTier: string = "unknown",
  ): string {
    const normalized = promptText.trim().toLowerCase().replace(/\s+/g, " ")
    const h = createHash("sha256")
      .update(`${agent}\u0001${contextLoad}\u0001${currentTier}\u0001${normalized}`)
      .digest("hex")
    return h.slice(0, 32)
  }

  get(hash: string): RoutingDecision | undefined {
    const entry = this.entries.get(hash)
    if (!entry) return undefined

    // Expired?
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(hash)
      return undefined
    }

    // LRU promote: re-insert at end
    this.entries.delete(hash)
    this.entries.set(hash, entry)
    entry.hits += 1

    return entry.decision
  }

  set(hash: string, decision: RoutingDecision): void {
    if (this.entries.size >= this.maxEntries) {
      // Evict oldest (first in insertion order)
      const oldest = this.entries.keys().next().value
      if (oldest) this.entries.delete(oldest)
    }
    this.entries.set(hash, {
      decision,
      createdAt: Date.now(),
      hits: 0,
    })
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }

  /** Total hits across all entries, for stats. */
  totalHits(): number {
    let total = 0
    for (const e of this.entries.values()) total += e.hits
    return total
  }
}
