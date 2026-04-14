/**
 * Mini-classifier for follow-up messages. Distinguishes:
 *   - continuation: "sim", "continua", "ok", "isso aí"
 *   - correction: "não é isso", "refaz", "errado, tenta outra vez"
 *   - question: "por que ...?", "o que isso significa?"
 *   - unknown: anything longer or more complex
 *
 * Regex + length based. Cheap, no LLM call.
 */

export type FollowUpCategory = "continuation" | "correction" | "question" | "unknown"

// Short affirmative-ish patterns (under ~20 chars + regex match)
const CONTINUATION_PATTERNS: RegExp[] = [
  /^\s*(sim|yes|ok|okay|pode|vai|continua|continue|go|segue|beleza|isso|certo)\s*[.!]*\s*$/iu,
  /^\s*isso\s+a[ií]\s*[.!]*\s*$/iu,
  /^\s*(next|proximo|próximo|segundo|depois)\s*[.!]*\s*$/iu,
  /^\s*(faz|faça|do it|go ahead|manda|manda ver)\s*[.!]*\s*$/iu,
]

const CORRECTION_PATTERNS: RegExp[] = [
  /\b(não é isso|nao e isso|not that|errado|wrong|tenta de novo|try again|refaz|redo|não funcion|nao funcion|not working)\b/i,
  /\b(isso está errado|this is wrong|faltou|missing|esqueceu|you forgot|volta)\b/i,
  /^(nao|não|no)[,\s]/i,
]

const QUESTION_PATTERNS: RegExp[] = [
  /\?(\s|$)/, // ends with or contains ?
  /^(por que|porque|why|what|como|how|when|quando|onde|where|qual)\b/i,
]

export function classifyFollowUp(text: string): FollowUpCategory {
  const trimmed = text.trim()
  if (trimmed.length === 0) return "unknown"

  // Short messages matching continuation patterns
  if (trimmed.length < 40) {
    for (const p of CONTINUATION_PATTERNS) {
      if (p.test(trimmed)) return "continuation"
    }
  }

  // Correction patterns (any length)
  for (const p of CORRECTION_PATTERNS) {
    if (p.test(trimmed)) return "correction"
  }

  // Question patterns
  for (const p of QUESTION_PATTERNS) {
    if (p.test(trimmed)) return "question"
  }

  return "unknown"
}
