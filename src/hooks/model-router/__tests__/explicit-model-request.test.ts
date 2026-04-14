import { describe, expect, test } from "bun:test"
import { detectExplicitModelRequest } from "../router/explicit-model-request"

describe("detectExplicitModelRequest", () => {
  test("pt-BR: 'utilize o opus' → opus", () => {
    const r = detectExplicitModelRequest("continuar, utilize o opus")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("opus")
  })

  test("pt-BR: 'use sonnet' → sonnet", () => {
    const r = detectExplicitModelRequest("ok, use sonnet pra essa")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("sonnet")
  })

  test("pt-BR: 'usa haiku' → haiku", () => {
    const r = detectExplicitModelRequest("usa haiku, é rápido o suficiente")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("haiku")
  })

  test("pt-BR: 'mude para opus' → opus", () => {
    const r = detectExplicitModelRequest("mude para opus porfavor")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("opus")
  })

  test("pt-BR: 'troca pro sonnet' → sonnet", () => {
    const r = detectExplicitModelRequest("troca pro sonnet")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("sonnet")
  })

  test("pt-BR: 'continuar com opus' → opus", () => {
    const r = detectExplicitModelRequest("continuar com opus")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("opus")
  })

  test("en: 'use opus' → opus", () => {
    const r = detectExplicitModelRequest("use opus please")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("opus")
  })

  test("en: 'switch to sonnet' → sonnet", () => {
    const r = detectExplicitModelRequest("switch to sonnet")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("sonnet")
  })

  test("en: 'change to haiku' → haiku", () => {
    const r = detectExplicitModelRequest("change to haiku, it's simpler")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("haiku")
  })

  test("no explicit request → null", () => {
    expect(detectExplicitModelRequest("continuar")).toBeNull()
    expect(detectExplicitModelRequest("fix the bug")).toBeNull()
    expect(detectExplicitModelRequest("implementa um endpoint")).toBeNull()
  })

  test("does NOT match when 'opus' is part of a word", () => {
    // "opusculo" shouldn't trigger — but our regex requires \bopus\b so it doesn't
    const r = detectExplicitModelRequest("use opusculo como exemplo")
    // This still matches because \bopus\b matches "opus" in "opusculo"? Let's see
    // Actually \b is at word boundaries — "opusculo" is 1 word so \bopus\b won't match middle
    expect(r).toBeNull()
  })

  test("case insensitive", () => {
    const r = detectExplicitModelRequest("Utilize o OPUS")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("opus")
  })

  test("exact screenshot case: 'continuar, utilize o opus'", () => {
    const r = detectExplicitModelRequest("continuar, utilize o opus")
    expect(r).not.toBeNull()
    expect(r!.tier).toBe("opus")
  })
})
