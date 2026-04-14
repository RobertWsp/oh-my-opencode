import { z } from "zod"

/**
 * Zod schema matching the TaskAnalysis tool input. Used both for:
 *   1. Generating the JSON schema sent to the analyzer as tool definition
 *   2. Validating the analyzer's structured output at runtime
 */

export const TaskTypeSchema = z.enum([
  "trivial_lookup",
  "simple_edit",
  "standard_implementation",
  "complex_refactor",
  "architectural",
  "debug_investigation",
  "research",
  "question_answer",
  "planning",
  "review",
])

export const ReasoningDepthSchema = z.enum(["none", "shallow", "medium", "deep", "exhaustive"])

export const ScopeBreadthSchema = z.enum([
  "single_line",
  "single_file",
  "multi_file_same_module",
  "cross_module",
  "system_wide",
  "unclear",
])

export const ContextRequirementSchema = z.enum(["minimal", "moderate", "extensive", "repo_wide"])
export const AmbiguitySchema = z.enum(["specific", "clear", "ambiguous", "vague"])
export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"])
export const NoveltySchema = z.enum(["standard", "uncommon", "novel", "unprecedented"])

export const DomainExpertiseSchema = z.enum([
  "generic",
  "language_specific",
  "framework_specific",
  "cross_domain",
  "specialized",
])

export const IterationProfileSchema = z.enum(["single_shot", "short_dialog", "long_session", "marathon"])

export const TaskAnalysisSchema = z.object({
  task_type: TaskTypeSchema,
  task_type_evidence: z.string().min(5).describe("Quote from the user's prompt supporting the task_type classification"),

  reasoning_depth: ReasoningDepthSchema,
  reasoning_depth_evidence: z
    .string()
    .min(5)
    .describe("Brief justification for the reasoning_depth choice, referencing the prompt"),

  scope_breadth: ScopeBreadthSchema,
  estimated_files_touched: z.number().int().nullable().describe("Best estimate of files that will be modified; null if unknowable"),

  context_requirements: ContextRequirementSchema,

  ambiguity: AmbiguitySchema,
  ambiguity_reasons: z
    .array(z.string())
    .describe("Specific unclear points in the prompt (empty array if ambiguity == 'specific')"),

  risk_level: RiskLevelSchema,
  risk_justification: z.string().min(5).describe("Why this risk level, based on what the prompt asks"),

  novelty: NoveltySchema,
  detected_technologies: z
    .array(z.string())
    .describe("Specific frameworks, languages, tools mentioned or clearly implied"),

  domain_expertise: DomainExpertiseSchema,

  iteration_profile: IterationProfileSchema,

  recommended_model: z.enum(["haiku", "sonnet", "opus"]).describe("Your tier recommendation (authoritative is the router)"),
  confidence: z.number().min(0).max(1).describe("How confident you are in this analysis"),
  primary_reasoning: z
    .string()
    .min(20)
    .describe("2-3 sentence justification tying the dimensions to the recommended_model"),
  contrarian_check: z
    .string()
    .min(10)
    .describe("Argue why the OPPOSITE tier might also be valid — forces balanced reasoning"),
})

export type TaskAnalysisSchemaOutput = z.infer<typeof TaskAnalysisSchema>

/**
 * Build the tool definition for Anthropic tool use. The analyzer will be
 * forced to call this tool (tool_choice = { type: "tool", name: "analyze_task" })
 * which guarantees structured output.
 */
export function buildAnalyzeTaskTool() {
  return {
    name: "analyze_task",
    description:
      "Submit the structured task analysis across 9 dimensions. Every field MUST have explicit evidence from the user prompt — no vague analyses allowed.",
    input_schema: buildAnalyzeTaskJsonSchema(),
  }
}

/**
 * Hand-written JSON Schema for the analyze_task tool. Kept in sync with
 * TaskAnalysisSchema above — single source of truth for the enum values,
 * dual representation for JSON Schema (what Anthropic tool_use wants).
 *
 * We do NOT use z.toJSONSchema() because Zod v4's API is unstable and
 * generates output that Anthropic's tool_use validator rejects. Hand-writing
 * is explicit and auditable.
 */
function buildAnalyzeTaskJsonSchema(): Record<string, unknown> {
  const enums = {
    task_type: TaskTypeSchema.options,
    reasoning_depth: ReasoningDepthSchema.options,
    scope_breadth: ScopeBreadthSchema.options,
    context_requirements: ContextRequirementSchema.options,
    ambiguity: AmbiguitySchema.options,
    risk_level: RiskLevelSchema.options,
    novelty: NoveltySchema.options,
    domain_expertise: DomainExpertiseSchema.options,
    iteration_profile: IterationProfileSchema.options,
  }

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "task_type",
      "task_type_evidence",
      "reasoning_depth",
      "reasoning_depth_evidence",
      "scope_breadth",
      "estimated_files_touched",
      "context_requirements",
      "ambiguity",
      "ambiguity_reasons",
      "risk_level",
      "risk_justification",
      "novelty",
      "detected_technologies",
      "domain_expertise",
      "iteration_profile",
      "recommended_model",
      "confidence",
      "primary_reasoning",
      "contrarian_check",
    ],
    properties: {
      task_type: { type: "string", enum: enums.task_type },
      task_type_evidence: {
        type: "string",
        description: "Quote from the user's prompt supporting the task_type classification",
      },
      reasoning_depth: { type: "string", enum: enums.reasoning_depth },
      reasoning_depth_evidence: {
        type: "string",
        description: "Brief justification for the reasoning_depth choice, referencing the prompt",
      },
      scope_breadth: { type: "string", enum: enums.scope_breadth },
      estimated_files_touched: {
        type: ["integer", "null"],
        description: "Best estimate of files that will be modified; null if unknowable",
      },
      context_requirements: { type: "string", enum: enums.context_requirements },
      ambiguity: { type: "string", enum: enums.ambiguity },
      ambiguity_reasons: {
        type: "array",
        items: { type: "string" },
        description: "Specific unclear points (empty array if ambiguity == 'specific')",
      },
      risk_level: { type: "string", enum: enums.risk_level },
      risk_justification: {
        type: "string",
        description: "Why this risk level, based on what the prompt asks",
      },
      novelty: { type: "string", enum: enums.novelty },
      detected_technologies: {
        type: "array",
        items: { type: "string" },
        description: "Specific frameworks, languages, tools mentioned or clearly implied",
      },
      domain_expertise: { type: "string", enum: enums.domain_expertise },
      iteration_profile: { type: "string", enum: enums.iteration_profile },
      recommended_model: { type: "string", enum: ["haiku", "sonnet", "opus"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      primary_reasoning: {
        type: "string",
        description: "2-3 sentence justification tying the dimensions to the recommended_model",
      },
      contrarian_check: {
        type: "string",
        description: "Argue why the OPPOSITE tier might also be valid",
      },
    },
  }
}
