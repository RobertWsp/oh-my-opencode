import type { TaskAnalysis } from "../types"

/**
 * Few-shot examples for the analyzer prompt.
 *
 * Curated to cover the decision surface without being leading:
 *  - One obvious case per tier
 *  - Two "deceiving" cases (simple-looking complex / complex-looking simple)
 *  - One ambiguity case
 *  - One follow-up case
 *  - One domain-specific (security) case
 *
 * Examples are intentionally diverse in language (pt-BR/en) and style.
 */

export type FewShotExample = {
  prompt: string
  analysis: TaskAnalysis
}

export const FEW_SHOT_EXAMPLES: FewShotExample[] = [
  // 1. Obvious Haiku
  {
    prompt: "fix the typo in the README — 'recieve' should be 'receive'",
    analysis: {
      task_type: "simple_edit",
      task_type_evidence: "'fix the typo' is a single-character correction",
      reasoning_depth: "none",
      reasoning_depth_evidence: "Trivial find-and-replace, no decisions",
      scope_breadth: "single_line",
      estimated_files_touched: 1,
      context_requirements: "minimal",
      ambiguity: "specific",
      ambiguity_reasons: [],
      risk_level: "low",
      risk_justification: "README changes have no runtime effect",
      novelty: "standard",
      detected_technologies: ["Markdown"],
      domain_expertise: "generic",
      iteration_profile: "single_shot",
      recommended_model: "haiku",
      confidence: 0.98,
      primary_reasoning:
        "Textbook haiku case — one character in documentation, zero reasoning, zero risk.",
      contrarian_check:
        "Sonnet would over-spend on a task where accuracy is already 100% for any model",
    },
  },

  // 2. Obvious Opus
  {
    prompt:
      "refactor our authentication middleware to use JWT refresh tokens. We currently store session tokens in httpOnly cookies. Need to migrate existing sessions gracefully without logging anyone out, handle mobile clients that cache the old format, and make sure the change rolls out safely. Also coordinate with the rate-limiting layer that depends on session IDs.",
    analysis: {
      task_type: "complex_refactor",
      task_type_evidence: "'refactor our authentication middleware' spanning multiple concerns",
      reasoning_depth: "deep",
      reasoning_depth_evidence:
        "Migration requires reasoning about existing state, mobile compatibility, and rollout order",
      scope_breadth: "cross_module",
      estimated_files_touched: 15,
      context_requirements: "extensive",
      ambiguity: "clear",
      ambiguity_reasons: [],
      risk_level: "critical",
      risk_justification: "Authentication breakage logs all users out and blocks access",
      novelty: "standard",
      detected_technologies: ["JWT", "HTTP cookies", "authentication middleware"],
      domain_expertise: "specialized",
      iteration_profile: "long_session",
      recommended_model: "opus",
      confidence: 0.94,
      primary_reasoning:
        "Cross-module refactor with critical risk, deep reasoning about migration path, and specialized auth domain — Opus territory.",
      contrarian_check:
        "Sonnet could write the code, but reasoning about graceful migration under concurrent active sessions benefits from deeper planning",
    },
  },

  // 3. Question (Haiku)
  {
    prompt: "qual a diferença entre Pick e Omit no TypeScript?",
    analysis: {
      task_type: "question_answer",
      task_type_evidence: "'qual a diferença' explanatory question",
      reasoning_depth: "shallow",
      reasoning_depth_evidence: "Well-known language feature comparison",
      scope_breadth: "single_line",
      estimated_files_touched: 0,
      context_requirements: "minimal",
      ambiguity: "specific",
      ambiguity_reasons: [],
      risk_level: "low",
      risk_justification: "Pure explanation, no code change",
      novelty: "standard",
      detected_technologies: ["TypeScript"],
      domain_expertise: "language_specific",
      iteration_profile: "single_shot",
      recommended_model: "haiku",
      confidence: 0.96,
      primary_reasoning: "Language-specific question with canonical answer — Haiku handles it.",
      contrarian_check: "Sonnet would give a slightly richer example but the core answer is identical",
    },
  },

  // 4. Standard implementation (Sonnet)
  {
    prompt: "implementa um endpoint de login com OAuth2 Google usando fastify, retorna JWT",
    analysis: {
      task_type: "standard_implementation",
      task_type_evidence: "'implementa um endpoint' new code following standard pattern",
      reasoning_depth: "medium",
      reasoning_depth_evidence: "OAuth2 flow needs 3-5 steps but is well documented",
      scope_breadth: "multi_file_same_module",
      estimated_files_touched: 4,
      context_requirements: "moderate",
      ambiguity: "clear",
      ambiguity_reasons: [],
      risk_level: "medium",
      risk_justification: "Auth code but following standard OAuth2 pattern",
      novelty: "standard",
      detected_technologies: ["OAuth2", "Fastify", "JWT", "Google"],
      domain_expertise: "framework_specific",
      iteration_profile: "short_dialog",
      recommended_model: "sonnet",
      confidence: 0.88,
      primary_reasoning:
        "Standard implementation against well-known stack. Sonnet is the workhorse for this scope.",
      contrarian_check: "Opus would be overkill; Haiku would miss framework nuances",
    },
  },

  // 5. Deceiving simple (looks easy, is risky)
  {
    prompt: "corrige o typo na função de validação de CPF",
    analysis: {
      task_type: "simple_edit",
      task_type_evidence: "'typo na função de validação'",
      reasoning_depth: "shallow",
      reasoning_depth_evidence: "Edit is small but must be verified against CPF algorithm",
      scope_breadth: "single_file",
      estimated_files_touched: 1,
      context_requirements: "moderate",
      ambiguity: "clear",
      ambiguity_reasons: [],
      risk_level: "high",
      risk_justification:
        "A 'typo' in CPF validation can silently corrupt fraud detection — misread as trivial but isn't",
      novelty: "standard",
      detected_technologies: ["CPF validation"],
      domain_expertise: "specialized",
      iteration_profile: "single_shot",
      recommended_model: "sonnet",
      confidence: 0.78,
      primary_reasoning:
        "Looks like Haiku material but risk_level=high + specialized domain (payment validation) push this to Sonnet for safety.",
      contrarian_check:
        "If the typo is genuinely cosmetic (comment/variable name), Haiku would suffice — but without confirmation we don't gamble on validation logic",
    },
  },

  // 6. Deceiving complex (sounds big, is mechanical)
  {
    prompt: "Refatora completamente o sistema de logging em todos os 50 microservicos pra usar Pino",
    analysis: {
      task_type: "standard_implementation",
      task_type_evidence: "'Refatora completamente ... pra usar Pino' — library replacement",
      reasoning_depth: "shallow",
      reasoning_depth_evidence: "Mechanical swap once the pattern is established",
      scope_breadth: "system_wide",
      estimated_files_touched: 150,
      context_requirements: "moderate",
      ambiguity: "clear",
      ambiguity_reasons: [],
      risk_level: "medium",
      risk_justification: "Logging change affects observability but not business logic",
      novelty: "standard",
      detected_technologies: ["Pino", "Node.js logging"],
      domain_expertise: "language_specific",
      iteration_profile: "long_session",
      recommended_model: "sonnet",
      confidence: 0.82,
      primary_reasoning:
        "Scope is wide (50 services) but the task is repetitive — establish pattern once, apply 50×. Sonnet fits.",
      contrarian_check:
        "Opus might be needed if each service has distinct logging shapes to harmonize; analyzer cannot tell without exploring",
    },
  },

  // 7. Ambiguity escalation
  {
    prompt: "melhora a performance da API",
    analysis: {
      task_type: "research",
      task_type_evidence: "'melhora a performance' — open-ended investigation",
      reasoning_depth: "deep",
      reasoning_depth_evidence: "Requires profiling, hypothesis, measurement, iteration",
      scope_breadth: "unclear",
      estimated_files_touched: null,
      context_requirements: "extensive",
      ambiguity: "vague",
      ambiguity_reasons: [
        "'performance' — latency? throughput? tail latency? cold-start?",
        "'the API' — which endpoints? which layer?",
        "no current baseline metrics mentioned",
      ],
      risk_level: "medium",
      risk_justification: "Perf changes can regress correctness if not careful",
      novelty: "uncommon",
      detected_technologies: [],
      domain_expertise: "specialized",
      iteration_profile: "long_session",
      recommended_model: "opus",
      confidence: 0.73,
      primary_reasoning:
        "Vague open-ended optimization = reasoning-heavy. Opus is better at scoping the investigation and ruling out paths.",
      contrarian_check:
        "If user clarifies 'add DB index on users.email' it collapses to Sonnet simple_edit — we should ask first",
    },
  },

  // 8. Debug investigation (Opus)
  {
    prompt: "algum lugar no código está vazando memória em produção, não sei onde começar",
    analysis: {
      task_type: "debug_investigation",
      task_type_evidence: "'algum lugar ... não sei onde começar' — root-cause search",
      reasoning_depth: "exhaustive",
      reasoning_depth_evidence: "Memory leak investigation requires hypothesis generation + verification loops",
      scope_breadth: "unclear",
      estimated_files_touched: null,
      context_requirements: "repo_wide",
      ambiguity: "ambiguous",
      ambiguity_reasons: ["'vazando memória' — sustained growth? spikes? OOM crashes?"],
      risk_level: "high",
      risk_justification: "Production memory leak causing real incidents",
      novelty: "novel",
      detected_technologies: [],
      domain_expertise: "specialized",
      iteration_profile: "marathon",
      recommended_model: "opus",
      confidence: 0.91,
      primary_reasoning:
        "Deep investigation across unknown surface, novel problem, high stakes — exactly where Opus reasoning pays for itself.",
      contrarian_check: "Sonnet could help narrow scope after profiling data is gathered, but not for the initial hypothesis",
    },
  },
]

/**
 * Render few-shots as a compact prompt section.
 */
export function renderFewShotSection(): string {
  const sections: string[] = []
  for (let i = 0; i < FEW_SHOT_EXAMPLES.length; i++) {
    const ex = FEW_SHOT_EXAMPLES[i]!
    sections.push(
      `Example ${i + 1}:\nUser prompt: ${JSON.stringify(ex.prompt)}\nAnalysis: ${JSON.stringify(ex.analysis)}`,
    )
  }
  return sections.join("\n\n")
}
