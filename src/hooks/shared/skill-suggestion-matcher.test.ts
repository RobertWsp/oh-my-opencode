import { describe, expect, test } from "bun:test";
import { matchSkills } from "./skill-suggestion-matcher";

const SKILLS = [
  {
    name: "vitest-testing",
    description: "Modern TypeScript/JavaScript testing with Vitest",
    location: "user" as const,
  },
  {
    name: "software-frontend",
    description: "Production-grade frontend engineering for React Next.js",
    location: "user" as const,
  },
  {
    name: "ruff-dev",
    description: "Python linter and formatter with ruff",
    location: "user" as const,
  },
  {
    name: "pydantic-dev",
    description: "Python data validation with Pydantic v2",
    location: "user" as const,
  },
  {
    name: "devops-engineer",
    description: "Docker kubernetes CI/CD infrastructure",
    location: "user" as const,
  },
  {
    name: "database-schema-designer",
    description: "SQL postgres database schema design",
    location: "user" as const,
  },
  {
    name: "zod",
    description: "TypeScript schema validation and type inference",
    location: "user" as const,
  },
];

describe("matchSkills", () => {
  test("returns empty for empty keywords", () => {
    expect(matchSkills([], SKILLS)).toEqual([]);
  });

  test("returns empty for empty skills", () => {
    expect(matchSkills(["typescript"], [])).toEqual([]);
  });

  test("matches typescript keywords", () => {
    const result = matchSkills(["typescript", "type"], SKILLS);
    const names = result.map((s) => s.name);
    expect(names).toContain("zod");
  });

  test("matches python keywords", () => {
    const result = matchSkills(["python", "pydantic", "validation"], SKILLS);
    const names = result.map((s) => s.name);
    expect(names).toContain("pydantic-dev");
  });

  test("matches testing keywords", () => {
    const result = matchSkills(["test", "testing", "vitest"], SKILLS);
    const names = result.map((s) => s.name);
    expect(names).toContain("vitest-testing");
  });

  test("matches database keywords", () => {
    const result = matchSkills(["database", "sql", "postgres"], SKILLS);
    const names = result.map((s) => s.name);
    expect(names).toContain("database-schema-designer");
  });

  test("respects limit parameter", () => {
    const result = matchSkills(["typescript", "type"], SKILLS, 1);
    expect(result.length).toBeLessThanOrEqual(1);
  });

  test("filters low-score matches below threshold", () => {
    const result = matchSkills(["typescript"], SKILLS);
    for (const s of result) {
      const tokens = `${s.name} ${s.description}`.toLowerCase().split(/\s+/);
      const hits = tokens.filter((t) => t.includes("typescript")).length;
      expect(hits).toBeGreaterThanOrEqual(1);
    }
  });

  test("prioritizes exact name matches", () => {
    const result = matchSkills(["zod"], SKILLS);
    expect(result[0].name).toBe("zod");
  });

  test("sorts by score descending", () => {
    const result = matchSkills(["python", "pydantic"], SKILLS);
    expect(result[0].name).toBe("pydantic-dev");
  });

  test("splits hyphenated skill names into tokens", () => {
    const result = matchSkills(["testing", "vitest"], SKILLS);
    const names = result.map((s) => s.name);
    expect(names).toContain("vitest-testing");
  });

  test("matches hyphenated skill with partial keyword", () => {
    const skills = [
      {
        name: "e2e-testing",
        description: "End to end testing with playwright",
        location: "user" as const,
      },
    ];
    const result = matchSkills(["testing", "e2e"], skills);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].name).toBe("e2e-testing");
  });
});
