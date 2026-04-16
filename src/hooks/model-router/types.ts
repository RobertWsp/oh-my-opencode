/**
 * Model Router — core types.
 *
 * The router analyzes an incoming task and picks the best Claude tier:
 *   - haiku:    fast, cheap — triviais, lookups, classificação
 *   - sonnet:   workhorse — implementação padrão
 *   - opus:     reasoning deep — arquitetura, debug complexo, risco crítico
 *   - opus-plan: híbrido — Opus planeja, Sonnet executa (mesmo histórico)
 *
 * The analysis is deliberate and non-vague: every dimension has explicit
 * evidence from the user prompt. Decisions are deterministic via the
 * decision matrix (see decision-matrix.ts) — the LLM analyzes, the code
 * decides.
 */

export type Tier = "haiku" | "sonnet" | "opus" | "opus-plan"

export type TaskType =
  | "trivial_lookup"
  | "simple_edit"
  | "standard_implementation"
  | "complex_refactor"
  | "architectural"
  | "debug_investigation"
  | "research"
  | "question_answer"
  | "planning"
  | "review"

export type ReasoningDepth = "none" | "shallow" | "medium" | "deep" | "exhaustive"

export type ScopeBreadth =
  | "single_line"
  | "single_file"
  | "multi_file_same_module"
  | "cross_module"
  | "system_wide"
  | "unclear"

export type ContextRequirement = "minimal" | "moderate" | "extensive" | "repo_wide"

export type Ambiguity = "specific" | "clear" | "ambiguous" | "vague"

export type RiskLevel = "low" | "medium" | "high" | "critical"

export type Novelty = "standard" | "uncommon" | "novel" | "unprecedented"

export type DomainExpertise =
  | "generic"
  | "language_specific"
  | "framework_specific"
  | "cross_domain"
  | "specialized"

export type IterationProfile = "single_shot" | "short_dialog" | "long_session" | "marathon"

/**
 * How confident the analyzer is in the complexity estimate.
 * low_confidence triggers conservative behavior: keep inline OR spawn with
 * escalation enabled so the subagent can self-upgrade if it discovers more
 * complexity than estimated.
 */
export type ComplexityUncertainty = "high_confidence" | "medium_confidence" | "low_confidence"

/**
 * Known intents that map directly to tier+reasoning defaults. Detected from
 * the prompt + analysis (ex: "commit and push" → commit_push). When null,
 * the decision matrix runs normally.
 */
export type DetectedIntent =
  | "commit_push"
  | "merge_simple"
  | "merge_complex"
  | "refactor_architectural"
  | "security_audit"
  | "bug_investigation"
  | "docs_update"
  | "test_write"
  | "lookup_qa"
  | null

/**
 * Full structured analysis of a task across 9 independent dimensions.
 * Each dimension carries explicit evidence (quote from prompt) to ensure
 * analyses are auditable and never vague.
 */
export interface TaskAnalysis {
  task_type: TaskType
  task_type_evidence: string

  reasoning_depth: ReasoningDepth
  reasoning_depth_evidence: string

  scope_breadth: ScopeBreadth
  estimated_files_touched: number | null

  context_requirements: ContextRequirement

  ambiguity: Ambiguity
  ambiguity_reasons: string[]

  risk_level: RiskLevel
  risk_justification: string

  novelty: Novelty
  detected_technologies: string[]

  domain_expertise: DomainExpertise

  iteration_profile: IterationProfile

  // Model's own recommendation (authoritative is decision matrix)
  recommended_model: "haiku" | "sonnet" | "opus"
  confidence: number // 0.0-1.0
  primary_reasoning: string
  contrarian_check: string

  // --- Extensions for subagent isolation (optional — may be absent in
  // older cached analyses or when analyzer skips them).
  complexity_uncertainty?: ComplexityUncertainty
  uncertainty_reason?: string
  subagent_suitable?: boolean
  subagent_isolation_reason?: string
  detected_intent?: DetectedIntent
}

/**
 * Context available at decision time.
 */
export interface RoutingContext {
  sessionID: string
  turnNumber: number
  agent: string
  currentModel: { providerID: string; modelID: string } | undefined
  userPromptText: string
  previousDecisions: RoutingDecision[] // for multi-turn awareness
  /**
   * Cumulative input tokens accumulated in this session so far (input +
   * cache reads). Used by the context-compatibility guard to reject
   * downgrades that can't fit the current context. 0 if unknown.
   */
  currentTotalInputTokens?: number
  /**
   * Current context load bucket: fresh / normal / heavy / saturated.
   * Included in decision cache key so we never reuse a "fresh" decision
   * in a now-heavy session.
   */
  contextLoad?: "fresh" | "normal" | "heavy" | "saturated"
  /**
   * Current model tier before routing (haiku/sonnet/opus). Included in
   * cache key so different starting points don't collide.
   */
  currentTierLabel?: Tier | undefined
}

/**
 * Final decision from the router. The tier is determined by the decision
 * matrix; reasons are the rules that fired.
 */
export interface RoutingDecision {
  timestamp: number
  sessionID: string
  turnNumber: number
  agent: string
  tier: Tier
  modelID: string
  providerID: string
  reasons: string[]
  analysis: TaskAnalysis | null // null when rules-fallback used
  analyzer: {
    used: boolean
    durationMs: number
    model: string
    fallbackUsed: boolean
    cached: boolean
    error?: string
  }
  confidence: number
  // Outcome fields — filled later by feedback-loop hook
  outcome?: RoutingOutcome
}

export interface RoutingOutcome {
  completedAt: number
  score: number // -1 to 1
  signals: {
    completedCleanly: boolean
    hasError: boolean
    userFollowedUp: boolean
    followUpCategory?: "continuation" | "correction" | "question" | "unknown"
    modelFallbackApplied: boolean
    userPinnedDifferentModel: boolean
    toolsExecutedCount: number
    // --- Extensions for subagent isolation ---
    subagentUsed?: boolean
    subagentSessionID?: string
    subagentDurationMs?: number
    escalationRequested?: boolean
    escalationFromTier?: Tier
    escalationToTier?: Tier
    escalationReason?: string
    totalDurationMs?: number
    qualityRating?: number // -1 (bad) / 0 (ok) / 1 (excellent)
  }
}

/**
 * Thread state for multi-turn awareness.
 */
export interface ThreadState {
  sessionID: string
  lastDecision: RoutingDecision | null
  lastPromptText: string
  turnCount: number
  lastUpdatedAt: number
  // opus-plan state machine
  planPhaseComplete: boolean // false = use Opus, true = use Sonnet
  planPhaseStartedAt: number | null
}

/**
 * Cache entry — prompt hash → decision.
 */
export interface CacheEntry {
  decision: RoutingDecision
  createdAt: number
  hits: number
}
