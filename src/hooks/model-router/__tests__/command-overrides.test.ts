import { describe, expect, test } from "bun:test"
import { detectCommand, enrichPromptForAnalyzer } from "../router/command-overrides"

describe("detectCommand", () => {
  test("/resolve-task → variable complexity (NOT forced)", () => {
    const prompt =
      "IMMEDIATELY read the file at /home/robert/.config/opencode/user-commands/resolve-task.md using the Read tool. The user's ClickUp task to resolve:\nhttps://app.clickup.com/t/868j296wh"
    const result = detectCommand(prompt)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("resolve-task")
    expect(result!.complexityProfile).toBe("variable")
    expect(result!.forcedTier).toBeUndefined()
    expect(result!.extractedArgs).toContain("clickup.com")
  })

  test("/senior-review → always_high → opus forced", () => {
    const prompt =
      "IMMEDIATELY read the file at /home/robert/.config/opencode/user-commands/senior-review.md using the Read tool."
    const result = detectCommand(prompt)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("senior-review")
    expect(result!.complexityProfile).toBe("always_high")
    expect(result!.forcedTier).toBe("opus")
  })

  test("/merge-complete → always_low → sonnet forced", () => {
    const prompt =
      "IMMEDIATELY read the file at /home/robert/.config/opencode/user-commands/merge-complete.md"
    const result = detectCommand(prompt)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("merge-complete")
    expect(result!.complexityProfile).toBe("always_low")
    expect(result!.forcedTier).toBe("sonnet")
  })

  test("normal prompt → null", () => {
    expect(detectCommand("implement a login endpoint")).toBeNull()
    expect(detectCommand("oi")).toBeNull()
  })
})

describe("enrichPromptForAnalyzer", () => {
  test("variable command enriches prompt with context", () => {
    const cmd = detectCommand(
      "IMMEDIATELY read the file at user-commands/resolve-task.md. The user's ClickUp task to resolve:\nhttps://app.clickup.com/t/868j296wh\n\nFAça com base na dev",
    )
    expect(cmd).not.toBeNull()
    const enriched = enrichPromptForAnalyzer("original", cmd!)
    expect(enriched).toContain("[COMMAND CONTEXT]")
    expect(enriched).toContain("/resolve-task")
    expect(enriched).toContain("End-to-end ClickUp")
    expect(enriched).toContain("Analyze the COMPLEXITY")
  })

  test("forced command returns original prompt unchanged", () => {
    const cmd = detectCommand(
      "IMMEDIATELY read the file at user-commands/senior-review.md",
    )
    expect(cmd).not.toBeNull()
    const enriched = enrichPromptForAnalyzer("original prompt text", cmd!)
    expect(enriched).toBe("original prompt text")
  })
})
