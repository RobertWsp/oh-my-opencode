import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder";

const MIN_SCORE = 2;

interface ScoredSkill {
  skill: AvailableSkill;
  score: number;
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "and",
  "but",
  "or",
  "not",
  "no",
  "nor",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "you",
  "your",
  "use",
  "when",
  "used",
  "using",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export function matchSkills(
  keywords: string[],
  available: AvailableSkill[],
  limit = 3,
): AvailableSkill[] {
  if (keywords.length === 0 || available.length === 0) return [];

  const query = new Set(keywords.map((k) => k.toLowerCase()));
  const scored: ScoredSkill[] = [];

  for (const skill of available) {
    const tokens = tokenize(`${skill.name} ${skill.description}`);
    let score = 0;
    for (const token of tokens) {
      if (query.has(token)) score++;
    }
    const lower = skill.name.toLowerCase();
    for (const kw of query) {
      if (lower === kw || lower.includes(kw)) score += 3;
    }
    if (score >= MIN_SCORE) scored.push({ skill, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.skill);
}
