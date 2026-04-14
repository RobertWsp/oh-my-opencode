/**
 * Structured prompt detector.
 *
 * Analysis of real OpenCode usage (7388 sessions, 170k messages) showed:
 *   - 76% of prompts are long (>300 chars) AND use explicit structure markers
 *   - Users in this codebase write prompts like:
 *       [CONTEXT]: ... [GOAL]: ... [REQUEST]: ...
 *       ## TASK ... ## EXPECTED OUTCOME ... ## REQUIRED TOOLS ...
 *       # Task: ... ## Working Directory ... ## Bug Description ...
 *   - These structured prompts are NOT ambiguous even when long — the user
 *     has already done the context-gathering work
 *
 * Detecting structured prompts lets the router:
 *   1. Downgrade ambiguity penalty (structured = user did the thinking)
 *   2. Trust the scope estimate from the prompt more
 *   3. Skip re-analysis on follow-ups within the same thread
 */

export interface StructuredPromptSignal {
  isStructured: boolean
  markers: string[]
  /** Rough indication of detail level based on markers + length. */
  detailLevel: "none" | "basic" | "detailed" | "comprehensive"
}

const STRUCTURE_MARKERS = [
  // bracket-style
  /\[CONTEXT\]/i,
  /\[GOAL\]/i,
  /\[REQUEST\]/i,
  /\[TASK\]/i,
  /\[DOWNSTREAM\]/i,
  /\[REASON\]/i,
  /\[REQUIREMENTS?\]/i,
  /\[EXPECTED[ _]OUTCOME\]/i,
  /\[ARCHITECTURE[ _]SUMMARY\]/i,

  // markdown-style: ##, ###, with optional numbered prefix "1.", "2."
  /^##?#?\s+(?:\d+\.\s+)?TASK\b/im,
  /^##?#?\s+(?:\d+\.\s+)?EXPECTED\s+OUTCOME/im,
  /^##?#?\s+(?:\d+\.\s+)?REQUIRED\s+TOOLS?/im,
  /^##?#?\s+(?:\d+\.\s+)?MUST\s+DO/im,
  /^##?#?\s+(?:\d+\.\s+)?BUG\s+DESCRIPTION/im,
  /^##?#?\s+(?:\d+\.\s+)?WORKING\s+DIRECTORY/im,
  /^##?#?\s+(?:\d+\.\s+)?STEPS?\b/im,
  /^##?#?\s+(?:\d+\.\s+)?CONTEXT\b/im,
  /^##?#?\s+(?:\d+\.\s+)?GOAL\b/im,

  // numbered requirements
  /^\s*-\s*\[\s*\]/m, // markdown checklists
  /^\s*\d+\.\s+TASK\b/im,
]

export function detectStructuredPrompt(prompt: string): StructuredPromptSignal {
  const markers: string[] = []

  for (const re of STRUCTURE_MARKERS) {
    const match = re.exec(prompt)
    if (match) markers.push(match[0])
  }

  const uniqueMarkers = Array.from(new Set(markers.map((m) => m.trim().replace(/\s+/g, " "))))

  const isStructured = uniqueMarkers.length >= 2

  let detailLevel: StructuredPromptSignal["detailLevel"] = "none"
  if (uniqueMarkers.length === 1) detailLevel = "basic"
  else if (uniqueMarkers.length >= 2 && prompt.length < 500) detailLevel = "detailed"
  else if (uniqueMarkers.length >= 2 && prompt.length >= 500) detailLevel = "comprehensive"

  return {
    isStructured,
    markers: uniqueMarkers,
    detailLevel,
  }
}
