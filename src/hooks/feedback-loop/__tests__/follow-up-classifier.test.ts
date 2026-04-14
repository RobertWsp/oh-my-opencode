import { describe, expect, test } from "bun:test"
import { classifyFollowUp } from "../follow-up-classifier"

describe("classifyFollowUp", () => {
  test("continuation — short affirmatives (pt-BR)", () => {
    expect(classifyFollowUp("sim")).toBe("continuation")
    expect(classifyFollowUp("ok")).toBe("continuation")
    expect(classifyFollowUp("continua")).toBe("continuation")
    expect(classifyFollowUp("beleza")).toBe("continuation")
    expect(classifyFollowUp("isso aí")).toBe("continuation")
  })

  test("continuation — short affirmatives (en)", () => {
    expect(classifyFollowUp("yes")).toBe("continuation")
    expect(classifyFollowUp("go ahead")).toBe("continuation")
    expect(classifyFollowUp("next")).toBe("continuation")
    expect(classifyFollowUp("do it")).toBe("continuation")
  })

  test("correction — explicit wrong signals", () => {
    expect(classifyFollowUp("não é isso, refaz")).toBe("correction")
    expect(classifyFollowUp("errado, tenta de novo")).toBe("correction")
    expect(classifyFollowUp("that's wrong, try again")).toBe("correction")
    expect(classifyFollowUp("nao, volta")).toBe("correction")
    expect(classifyFollowUp("you forgot the null check")).toBe("correction")
  })

  test("question — interrogatives", () => {
    expect(classifyFollowUp("por que você fez isso?")).toBe("question")
    expect(classifyFollowUp("what does this do?")).toBe("question")
    expect(classifyFollowUp("qual a razão?")).toBe("question")
    expect(classifyFollowUp("how about the edge case?")).toBe("question")
  })

  test("unknown — longer or mixed messages", () => {
    expect(classifyFollowUp("vamos tentar outra abordagem agora com cache")).toBe("unknown")
    expect(classifyFollowUp("add a helper function for validation and tests for it")).toBe("unknown")
  })

  test("empty input → unknown", () => {
    expect(classifyFollowUp("")).toBe("unknown")
    expect(classifyFollowUp("   ")).toBe("unknown")
  })

  test("case-insensitive matching", () => {
    expect(classifyFollowUp("SIM")).toBe("continuation")
    expect(classifyFollowUp("OK")).toBe("continuation")
    expect(classifyFollowUp("Wrong!")).toBe("correction")
  })
})
