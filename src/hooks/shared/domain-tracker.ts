export type Domain =
  | "frontend"
  | "backend-ts"
  | "python"
  | "devops"
  | "database"
  | "styling"
  | "testing"
  | "unknown";

const EXT_DOMAIN: Record<string, Domain> = {
  ".tsx": "frontend",
  ".jsx": "frontend",
  ".vue": "frontend",
  ".svelte": "frontend",
  ".html": "frontend",
  ".css": "styling",
  ".scss": "styling",
  ".less": "styling",
  ".ts": "backend-ts",
  ".js": "backend-ts",
  ".mjs": "backend-ts",
  ".py": "python",
  ".pyi": "python",
  ".pyx": "python",
  ".dockerfile": "devops",
  ".yaml": "devops",
  ".yml": "devops",
  ".toml": "devops",
  ".json": "devops",
  ".sh": "devops",
  ".xml": "devops",
  ".sql": "database",
  ".test.ts": "testing",
  ".test.tsx": "testing",
  ".spec.ts": "testing",
  ".spec.tsx": "testing",
  ".test.py": "testing",
  ".test.js": "testing",
  ".spec.js": "testing",
};

export const DOMAIN_KEYWORDS: Record<Domain, string[]> = {
  frontend: [
    "react",
    "frontend",
    "component",
    "jsx",
    "tsx",
    "ui",
    "css",
    "tailwind",
    "next",
    "vue",
    "svelte",
    "html",
    "webpack",
    "vite",
    "angular",
    "remix",
  ],
  "backend-ts": [
    "typescript",
    "node",
    "backend",
    "api",
    "server",
    "express",
    "fastify",
    "bun",
    "http",
    "rest",
    "graphql",
    "websocket",
    "hono",
    "trpc",
    "zod",
  ],
  python: [
    "python",
    "fastapi",
    "django",
    "flask",
    "pydantic",
    "pytest",
    "uv",
    "ruff",
    "pip",
    "poetry",
    "celery",
    "async",
    "asyncio",
  ],
  devops: [
    "docker",
    "devops",
    "ci",
    "cd",
    "kubernetes",
    "deploy",
    "infrastructure",
    "terraform",
    "container",
    "aws",
    "gcp",
    "nginx",
    "helm",
    "compose",
  ],
  database: [
    "database",
    "sql",
    "postgres",
    "mysql",
    "sqlite",
    "migration",
    "schema",
    "drizzle",
    "prisma",
    "redis",
    "mongodb",
    "query",
    "index",
  ],
  styling: [
    "css",
    "tailwind",
    "styling",
    "scss",
    "animation",
    "design",
    "theme",
    "responsive",
  ],
  testing: [
    "test",
    "testing",
    "vitest",
    "jest",
    "pytest",
    "playwright",
    "e2e",
    "spec",
    "assertion",
    "unit",
    "integration",
    "mock",
  ],
  unknown: [],
};

const DOMAIN_GROUPS: Record<string, Domain[]> = {
  typescript: ["frontend", "backend-ts"],
  web: ["frontend", "styling"],
};

function related(a: Domain, b: Domain): boolean {
  if (a === b) return true;
  for (const group of Object.values(DOMAIN_GROUPS)) {
    if (group.includes(a) && group.includes(b)) return true;
  }
  return false;
}

const MAX_COUNT = 50;

interface SessionDomain {
  current: Domain;
  previous: Domain | undefined;
  count: number;
}

const sessions = new Map<string, SessionDomain>();

const BACKUP_SUFFIXES = [".bak", ".old", ".tmp", ".orig", ".backup"];

export function extractExt(path: string): string {
  let base = path.split("/").pop() ?? "";

  for (const suffix of BACKUP_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  if (base.endsWith("~")) base = base.slice(0, -1);

  for (const ext of Object.keys(EXT_DOMAIN)) {
    if (
      ext.startsWith(".") &&
      ext.includes(".") &&
      ext.length > 4 &&
      base.endsWith(ext)
    ) {
      return ext;
    }
  }
  const dot = base.lastIndexOf(".");
  if (dot === -1) return "";
  return base.slice(dot).toLowerCase();
}

export function toDomain(ext: string): Domain {
  return EXT_DOMAIN[ext] ?? "unknown";
}

export function extractPath(output: string, _tool: string): string | undefined {
  const abs = output.match(/^\s*(\/[^\s\n:]+\.[a-z]{1,6})/m);
  if (abs) return abs[1];

  const mid = output.match(/(?:^|\s)(\/[^\s:]+\.[a-z]{1,6})/m);
  if (mid) return mid[1];

  const rel = output.match(
    /\b([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-z]{1,6})\b/m,
  );
  return rel?.[1];
}

export function update(sessionID: string, domain: Domain): boolean {
  const state = sessions.get(sessionID);
  if (!state) {
    sessions.set(sessionID, { current: domain, previous: undefined, count: 1 });
    return false;
  }
  if (related(state.current, domain)) {
    state.current = domain;
    if (state.count < MAX_COUNT) state.count++;
    return false;
  }
  state.previous = state.current;
  state.current = domain;
  state.count = 1;
  return true;
}

export function current(sessionID: string): Domain | undefined {
  return sessions.get(sessionID)?.current;
}

export function clear(sessionID: string): void {
  sessions.delete(sessionID);
}
