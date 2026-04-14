import { getAgentConfigKey } from "../../../shared/agent-display-names"
import { AGENT_TIER_OVERRIDES } from "../constants"
import type { RoutingContext, Tier } from "../types"

/**
 * Rules-based fallback when the analyzer fails (timeout, schema error,
 * API error, missing API key). Conservative: defaults to Sonnet on
 * anything ambiguous.
 *
 * This is NOT meant to be accurate — it's a safety net that keeps the
 * system working when the analyzer is unavailable. The user shouldn't
 * notice a quality drop for common tasks.
 */

export interface RulesFallbackResult {
  tier: Tier
  reasons: string[]
}

const HAIKU_KEYWORD_PATTERNS: RegExp[] = [
  // Typo fixes — en + pt-BR
  /^(fix|corrige|corrija|arrume|arruma)\s+(the\s+|o\s+|a\s+)?(typo|typografi|spell|erro de digit|erro\s+de\s+digita)/iu,
  // Scoped rename
  /^(rename|renomeia|renomear)\s+\S+\s+(to|para|pra)\s+\S+$/iu,
  // Q&A starters
  /^(what('s|\s+is)|qual\s+(a|e|[eé])\s+(diferen[çc]a|diff))/iu,
  /^(explain|explica|explique|diga)\s+/iu,
  /^(list|lista|liste)\s+/iu,
  /^(show|mostra|mostre|exibe|exibir)\s+/iu,
  // Greetings / super short
  /^\s*(hi|hello|oi|ol[aá]|hey|ping|pong|test|teste|ok|yes|sim)\s*[.!?]*\s*$/iu,
  // Single command / lookup
  /^(run|execute|roda|rode|executa)\s+[`'"]?[\w\s./-]+[`'"]?\s*$/iu,
]

const OPUS_KEYWORD_PATTERNS: RegExp[] = [
  // Refactor/redesign — en + pt-BR
  /\b(refactor|refatorar|refatora)\b.*(cross|multi|system|architecture|arquitetur|todo o sistema|entire|inteir)/iu,
  /(redesign|reestrutur|redesenhar)/iu,
  // Migration — multi-file, often complex
  /\b(migrar|migration)\b.*(sem logout|zero downtime|graceful|sessions existentes|existing sessions)/iu,
  // Debugging complex issues
  /\b(memory leak|vazamento de mem|deadlock|race condition|concorr[eê]ncia)\b/iu,
  // Security / audit — bidirectional (audit-of-security OR security-audit)
  /\b(security|seguran[cç]a)\b.*(audit|review|an[aá]lise|auditoria|revis[aã]o)/iu,
  /\b(audit|review|an[aá]lise|auditoria|revis[aã]o).*\b(security|seguran[cç]a)\b/iu,
  /\b(vulnerability|vulnerabilidade|cve|rce|xss|csrf|sqli|injection|inje[cç][aã]o)\b/iu,
  // Architecture
  /\b(architectural|arquitetural|system design|event[- ]sourc|microservi)/iu,
  // Production debug
  /\bdebug\b.*(production|produ[cç][aã]o|prod)/iu,
  // Cross-cutting concerns
  /\b(coordenar|coordinate)\b.*(rate limit|auth|multiple systems|m[uú]ltiplos)/iu,
  // Multi-module / system-wide indicators
  /\b(todo o|entire|across the|across all|across every|all services|system[- ]wide)\b.*(service|module|component|codebase|repo)/iu,
  // Detailed analysis / review — "análise detalhada", "revisão completa", etc.
  // These are explicit asks for deep reasoning regardless of domain.
  // NOTE: trailing \b is intentionally omitted on pt-BR stems because
  // "minuciosa"/"detalhada"/"profunda" end in vowels after word chars.
  /\b(an[aá]lise|revis[aã]o|review|analysis|auditoria)\b[^.!?]{0,60}\b(detalhad|minucios|profund|completa|completo|exaustiv|thorough|detailed|in[- ]depth|comprehensive)/iu,
  /\b(detalhad|minucios|profund|completa|completo|exaustiv|thorough|detailed|in[- ]depth|comprehensive)[^.!?]{0,60}\b(an[aá]lise|revis[aã]o|review|analysis|auditoria)\b/iu,
  // CI/CD, deploy, pipeline, branch — debug investigations
  /\b(ci[\s/\-]?cd|pipeline|deploy(s|ment)?|release|rollout|canary)\b[^.!?]{0,80}\b(debug|investig|falh|erro|broken|quebr|desatualiz|bug|issue|problem[a]?|n[aã]o\s+(funciona|roda|executa)|stuck|travad|hang)/iu,
  /\b(debug|investig|falh|erro|broken|quebr|desatualiz|bug|issue|problem[a]?)\b[^.!?]{0,80}\b(ci[\s/\-]?cd|pipeline|deploy(s|ment)?|release|rollout|canary)\b/iu,
  // Branch/ref/HEAD desatualizados ou divergentes — tipicamente requer raciocínio
  /\b(branch(es)?|refs?|HEAD|origin)\b[^.!?]{0,40}\b(desatualiz|outdated|stale|behind|atr[aá]s|divergente|diverg|conflict|conflit|merge\s+conflict)/iu,
  // Root cause / causa raiz — sempre opus
  /\b(root\s+cause|causa\s+ra[ií]z|rca|por\s+que(\s+(isso|est[aá]|n[aã]o))?)\b/iu,
  // Planejar/projetar algo complexo
  /\b(plane(j|jamento|je|ja)|plan(ning)?)\b[^.!?]{0,60}\b(refactor|migration|migra[çc][aã]o|arquitetur|redesign|sistema|m[oó]dulos|service|microservi)/iu,
]

/**
 * Approximate prompt-length heuristic. Longer prompts (especially ones
 * with code blocks or detailed specs) usually indicate more complex tasks.
 *
 * Note: this is a last-resort fallback. Opus triggers should come from
 * keyword patterns or the analyzer; length alone is NOT enough evidence
 * to force opus (would over-promote casual long prompts).
 */
function charBucketTier(promptText: string): Tier | null {
  const len = promptText.trim().length
  if (len < 40) return "haiku"
  if (len > 400) return "sonnet" // Medium/long prompts → sonnet workhorse
  return null
}

export function rulesFallback(ctx: RoutingContext): RulesFallbackResult {
  const reasons: string[] = []
  const prompt = ctx.userPromptText ?? ""

  // Agent override first — normalize display name → config key
  const agentKey = getAgentConfigKey(ctx.agent)
  const agentForced = AGENT_TIER_OVERRIDES[agentKey]
  if (agentForced) {
    reasons.push(`agent:${agentKey}→${agentForced}`)
    return { tier: agentForced, reasons }
  }

  // Opus keywords (check before haiku to avoid false-positives)
  for (const pattern of OPUS_KEYWORD_PATTERNS) {
    if (pattern.test(prompt)) {
      reasons.push(`opus:rules_keyword:${pattern.source.slice(0, 30)}`)
      return { tier: "opus", reasons }
    }
  }

  // Haiku keywords
  for (const pattern of HAIKU_KEYWORD_PATTERNS) {
    if (pattern.test(prompt)) {
      reasons.push(`haiku:rules_keyword:${pattern.source.slice(0, 30)}`)
      return { tier: "haiku", reasons }
    }
  }

  // Length-based fallback
  const lenTier = charBucketTier(prompt)
  if (lenTier) {
    reasons.push(`${lenTier}:rules_length=${prompt.length}`)
    return { tier: lenTier, reasons }
  }

  reasons.push("sonnet:rules_default")
  return { tier: "sonnet", reasons }
}
