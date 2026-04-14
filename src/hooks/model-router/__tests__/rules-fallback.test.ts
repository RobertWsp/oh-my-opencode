import { describe, expect, test } from "bun:test"
import { rulesFallback } from "../router/rules-fallback"
import type { RoutingContext } from "../types"

function ctx(prompt: string, agent: string = "build"): RoutingContext {
  return {
    sessionID: "t",
    turnNumber: 1,
    agent,
    currentModel: undefined,
    userPromptText: prompt,
    previousDecisions: [],
  }
}

describe("rulesFallback", () => {
  test("agent override wins over prompt keywords", () => {
    const r = rulesFallback(ctx("refatorar o sistema inteiro", "oracle"))
    expect(r.tier).toBe("opus")
    expect(r.reasons[0]).toContain("oracle")
  })

  test("pt-BR: refatorar multi-sistema → opus", () => {
    const r = rulesFallback(
      ctx(
        "preciso refatorar todo o sistema de autenticação para JWT com refresh tokens, migrar sessões existentes sem logout",
      ),
    )
    expect(r.tier).toBe("opus")
  })

  test("pt-BR: vazamento de memória → opus", () => {
    const r = rulesFallback(ctx("investigar vazamento de memória na aplicação de TV"))
    expect(r.tier).toBe("opus")
  })

  test("pt-BR: segurança + auditoria → opus", () => {
    const r = rulesFallback(ctx("fazer análise de segurança do JWT validation"))
    expect(r.tier).toBe("opus")
  })

  test("en: architecture design → opus", () => {
    const r = rulesFallback(ctx("architectural redesign of our event sourcing model"))
    expect(r.tier).toBe("opus")
  })

  test("typo fix pt-BR → haiku", () => {
    const r = rulesFallback(ctx("corrige o typo no README"))
    expect(r.tier).toBe("haiku")
  })

  test("typo fix en → haiku", () => {
    const r = rulesFallback(ctx("fix the typo in README"))
    expect(r.tier).toBe("haiku")
  })

  test("rename short → haiku", () => {
    const r = rulesFallback(ctx("renomeia userData para accountData"))
    expect(r.tier).toBe("haiku")
  })

  test("question → haiku", () => {
    const r = rulesFallback(ctx("qual a diferença entre Pick e Omit"))
    expect(r.tier).toBe("haiku")
  })

  test("greeting → haiku", () => {
    const r = rulesFallback(ctx("oi"))
    expect(r.tier).toBe("haiku")
  })

  test("explain → haiku", () => {
    const r = rulesFallback(ctx("explica como funciona o useEffect"))
    expect(r.tier).toBe("haiku")
  })

  test("ambiguous/medium → sonnet default", () => {
    const r = rulesFallback(ctx("implementa um endpoint de login com OAuth2 Google usando fastify"))
    expect(r.tier).toBe("sonnet")
  })

  test("long prompt without keywords → sonnet", () => {
    const r = rulesFallback(
      ctx(
        "I need to add a new feature to our React application that allows users to filter the list of products by multiple criteria simultaneously, with proper debouncing",
      ),
    )
    expect(r.tier).toBe("sonnet")
  })

  test("very short → haiku length bucket", () => {
    const r = rulesFallback(ctx("ping"))
    expect(r.tier).toBe("haiku")
  })

  test("explore agent override → haiku", () => {
    const r = rulesFallback(
      ctx(
        "refactor the entire authentication system across all modules and coordinate with rate limiter",
        "explore",
      ),
    )
    expect(r.tier).toBe("haiku")
  })

  test("Sisyphus display name → NOT overridden (falls through to rules)", () => {
    // Sisyphus is intentionally NOT in AGENT_TIER_OVERRIDES because
    // ALL prompts arrive as "Sisyphus (Ultraworker)" from oh-my-opencode.
    const r = rulesFallback(ctx("any prompt", "Sisyphus (Ultraworker)"))
    // "any prompt" is short (10 chars) → haiku via length bucket
    expect(r.tier).toBe("haiku")
    expect(r.reasons[0]).not.toContain("agent:")
  })

  // ─── pt-BR: análise/revisão detalhada (não depende de contexto security) ───
  test("pt-BR: análise detalhada → opus", () => {
    const r = rulesFallback(ctx("Eu preciso que faça uma análise detalhada do problema do deploy"))
    expect(r.tier).toBe("opus")
  })

  test("pt-BR: revisão completa → opus", () => {
    const r = rulesFallback(ctx("Por favor faça uma revisão completa do fluxo de autenticação"))
    expect(r.tier).toBe("opus")
  })

  test("pt-BR: análise minuciosa → opus", () => {
    const r = rulesFallback(ctx("preciso de uma análise minuciosa da pipeline de ingestão"))
    expect(r.tier).toBe("opus")
  })

  test("en: detailed analysis → opus", () => {
    const r = rulesFallback(ctx("give me a detailed analysis of the ingestion pipeline behavior"))
    expect(r.tier).toBe("opus")
  })

  test("en: in-depth review → opus", () => {
    const r = rulesFallback(ctx("I need an in-depth review of the websocket reconnection logic"))
    expect(r.tier).toBe("opus")
  })

  // ─── CI/CD, deploy, pipeline debugging ────────────────────────────────
  test("pt-BR: CI/CD falhando → opus", () => {
    const r = rulesFallback(ctx("o pipeline de CI/CD está falhando após o último merge, preciso debugar"))
    expect(r.tier).toBe("opus")
  })

  test("pt-BR: deploy quebrado → opus", () => {
    const r = rulesFallback(ctx("o deploy está quebrado na branch canary, investiga o que aconteceu"))
    expect(r.tier).toBe("opus")
  })

  test("pt-BR: branch desatualizada → opus", () => {
    const r = rulesFallback(ctx("a branch está desatualizada em relação ao main, preciso resolver os conflitos"))
    expect(r.tier).toBe("opus")
  })

  // ─── Root cause ───────────────────────────────────────────────────────
  test("pt-BR: causa raiz → opus", () => {
    const r = rulesFallback(ctx("descobrir a causa raiz do intermitente que só acontece em prod"))
    expect(r.tier).toBe("opus")
  })

  test("en: root cause → opus", () => {
    const r = rulesFallback(ctx("find the root cause of the intermittent failures in staging"))
    expect(r.tier).toBe("opus")
  })

  // ─── Medium-length prompt without keywords still falls back to sonnet ─
  test("medium prompt (>400 chars) without opus keywords → sonnet", () => {
    const prompt =
      "Preciso adicionar um novo endpoint REST em /api/products que liste produtos filtrados por categoria. " +
      "O backend usa Fastify com Prisma. Retorne a lista ordenada por nome, paginada por cursor e com suporte a multiplos sort keys. " +
      "Inclua testes unitários usando bun:test e valide o schema com Zod. Siga o padrão dos outros endpoints do repo, " +
      "que já tem handlers em src/routes. Pode ser uma implementação direta, nada de migração ou refactor."
    expect(prompt.length).toBeGreaterThan(400)
    const r = rulesFallback(ctx(prompt))
    expect(r.tier).toBe("sonnet")
  })
})
