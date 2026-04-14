/**
 * Detects when the user EXPLICITLY asks for a specific model in the
 * prompt. These are unambiguous — no analyzer needed, just honor the
 * request.
 *
 * Examples:
 *   - "continuar, utilize o opus"
 *   - "use haiku"
 *   - "mude para sonnet"
 *   - "switch to opus please"
 *   - "change to haiku"
 *
 * Only fires on exact tier names. Won't match e.g. "opus-plan" because
 * that's a router-internal alias, not a model the user knows about.
 */

import type { Tier } from "../types"

const EXPLICIT_MODEL_PATTERNS: Array<{ pattern: RegExp; tier: Tier }> = [
  // pt-BR
  { pattern: /\b(use|utilize|utiliza|usa|usar|ativa|ativar)\s+(o\s+)?opus\b/iu, tier: "opus" },
  { pattern: /\b(use|utilize|utiliza|usa|usar|ativa|ativar)\s+(o\s+)?sonnet\b/iu, tier: "sonnet" },
  { pattern: /\b(use|utilize|utiliza|usa|usar|ativa|ativar)\s+(o\s+)?haiku\b/iu, tier: "haiku" },
  { pattern: /\b(mude|muda|troca|troque|mudar|trocar)\s+(para|pra|pro)\s+opus\b/iu, tier: "opus" },
  { pattern: /\b(mude|muda|troca|troque|mudar|trocar)\s+(para|pra|pro)\s+sonnet\b/iu, tier: "sonnet" },
  { pattern: /\b(mude|muda|troca|troque|mudar|trocar)\s+(para|pra|pro)\s+haiku\b/iu, tier: "haiku" },
  { pattern: /\bcom\s+(o\s+)?opus\b/iu, tier: "opus" },
  { pattern: /\bcom\s+(o\s+)?sonnet\b/iu, tier: "sonnet" },
  { pattern: /\bcom\s+(o\s+)?haiku\b/iu, tier: "haiku" },

  // en
  { pattern: /\b(use|switch to|change to|with)\s+opus\b/iu, tier: "opus" },
  { pattern: /\b(use|switch to|change to|with)\s+sonnet\b/iu, tier: "sonnet" },
  { pattern: /\b(use|switch to|change to|with)\s+haiku\b/iu, tier: "haiku" },
]

export interface ExplicitModelRequest {
  tier: Tier
  matchedPattern: string
}

export function detectExplicitModelRequest(promptText: string): ExplicitModelRequest | null {
  for (const { pattern, tier } of EXPLICIT_MODEL_PATTERNS) {
    const match = pattern.exec(promptText)
    if (match) {
      return { tier, matchedPattern: match[0] }
    }
  }
  return null
}
