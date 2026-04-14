import { describe, expect, test } from "bun:test"
import { decideFromAnalysis } from "../router/decision-matrix"
import type { RoutingContext } from "../types"
import { GOLDEN_CASES, countByCategory } from "./golden-cases"

/**
 * Golden test runner. Applies the decision matrix to each pre-validated
 * analysis and checks that the picked tier matches the expected one (or
 * the adjacent-OK fallback for edge cases).
 *
 * This is PURE matrix validation — we don't run the live analyzer here.
 * The analyzer itself is tested via integration (F9).
 */

function buildContext(prompt: string, agent: string = "build"): RoutingContext {
  return {
    sessionID: "test",
    turnNumber: 1,
    agent,
    currentModel: undefined,
    userPromptText: prompt,
    previousDecisions: [],
  }
}

describe("model-router / decision matrix / golden cases", () => {
  test("test corpus has expected shape", () => {
    const counts = countByCategory()
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(60)
    // Each category has at least 5 cases
    for (const cat of ["A", "B", "C", "D", "E", "F", "G"] as const) {
      expect(counts[cat]).toBeGreaterThanOrEqual(5)
    }
  })

  for (const gc of GOLDEN_CASES) {
    test(`${gc.id} [${gc.category}] ${gc.prompt.slice(0, 60)}`, () => {
      const ctx = buildContext(gc.prompt, gc.agent ?? "build")
      const decision = decideFromAnalysis(gc.analysis, ctx)

      const acceptable = [gc.expectedTier, ...(gc.adjacentOk ?? [])]
      const matches = acceptable.includes(decision.tier)

      if (!matches) {
        // Produce a readable failure message
        throw new Error(
          `${gc.id}: expected tier ∈ [${acceptable.join(", ")}] but decision matrix returned "${decision.tier}"\n` +
            `  reasons: ${decision.reasons.join(", ")}\n` +
            `  analysis.task_type: ${gc.analysis.task_type}\n` +
            `  analysis.reasoning_depth: ${gc.analysis.reasoning_depth}\n` +
            `  analysis.scope_breadth: ${gc.analysis.scope_breadth}\n` +
            `  analysis.risk_level: ${gc.analysis.risk_level}\n` +
            `  analysis.ambiguity: ${gc.analysis.ambiguity}\n` +
            `  notes: ${gc.notes}`,
        )
      }

      expect(acceptable).toContain(decision.tier)
    })
  }

  test("aggregate: at least 85% of cases use exact expected tier (not adjacent)", () => {
    let exact = 0
    let total = 0
    let adjacent = 0
    const failures: string[] = []
    for (const gc of GOLDEN_CASES) {
      total++
      const ctx = buildContext(gc.prompt, gc.agent ?? "build")
      const decision = decideFromAnalysis(gc.analysis, ctx)
      if (decision.tier === gc.expectedTier) {
        exact++
      } else if (gc.adjacentOk?.includes(decision.tier)) {
        adjacent++
      } else {
        failures.push(`${gc.id}: got ${decision.tier}, wanted ${gc.expectedTier}`)
      }
    }

    const exactRate = exact / total
    console.log(
      `\nGolden corpus: ${exact}/${total} exact (${(exactRate * 100).toFixed(0)}%), ${adjacent} adjacent, ${failures.length} failures`,
    )
    if (failures.length > 0) {
      console.log("Failures:\n  " + failures.slice(0, 5).join("\n  "))
    }

    // Accept at least 85% exact + allow adjacent-OK as passing
    expect(exactRate).toBeGreaterThanOrEqual(0.85)
  })
})
