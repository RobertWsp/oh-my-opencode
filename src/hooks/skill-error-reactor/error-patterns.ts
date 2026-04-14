export type ErrorCategory =
  | "typescript"
  | "python"
  | "react"
  | "test"
  | "build"
  | "database"
  | "docker"
  | "security"
  | "network"
  | "permission";

export interface ClassifiedError {
  category: ErrorCategory;
  keywords: string[];
}

export const PATTERNS: Array<{
  re: RegExp;
  category: ErrorCategory;
  keywords: string[];
}> = [
  {
    re: /TS\d{4,5}:/i,
    category: "typescript",
    keywords: ["typescript", "type", "tsc", "ts"],
  },
  {
    re: /Type\s+'[^']+'\s+is not assignable/i,
    category: "typescript",
    keywords: ["typescript", "type", "ts"],
  },
  {
    re: /Cannot find module/i,
    category: "typescript",
    keywords: ["typescript", "module", "import"],
  },
  {
    re: /Property '.*' does not exist on type/i,
    category: "typescript",
    keywords: ["typescript", "type"],
  },

  {
    re: /ModuleNotFoundError:/i,
    category: "python",
    keywords: ["python", "module", "import", "pip", "uv"],
  },
  {
    re: /ImportError:/i,
    category: "python",
    keywords: ["python", "import", "module"],
  },
  {
    re: /IndentationError:/i,
    category: "python",
    keywords: ["python", "syntax", "indentation"],
  },
  {
    re: /NameError:/i,
    category: "python",
    keywords: ["python", "variable", "reference"],
  },
  {
    re: /AttributeError:/i,
    category: "python",
    keywords: ["python", "attribute", "object"],
  },
  {
    re: /Traceback \(most recent call last\)/i,
    category: "python",
    keywords: ["python", "error", "traceback"],
  },
  {
    re: /pydantic.*ValidationError/i,
    category: "python",
    keywords: ["python", "pydantic", "validation"],
  },

  {
    re: /TypeError:/i,
    category: "typescript",
    keywords: ["typescript", "type", "error"],
  },
  {
    re: /SyntaxError:/i,
    category: "build",
    keywords: ["build", "syntax", "parse"],
  },

  {
    re: /React.*Hook/i,
    category: "react",
    keywords: ["react", "hook", "component", "frontend"],
  },
  {
    re: /Invalid hook call/i,
    category: "react",
    keywords: ["react", "hook", "component"],
  },
  {
    re: /hydration\s*(mismatch|error|warning|failed)/i,
    category: "react",
    keywords: ["react", "hydration", "ssr", "next"],
  },
  {
    re: /JSX element/i,
    category: "react",
    keywords: ["react", "jsx", "component", "frontend"],
  },

  {
    re: /FAIL\s+[\w/.]/i,
    category: "test",
    keywords: ["test", "testing", "vitest", "jest"],
  },
  {
    re: /test(s)?\s+failed/i,
    category: "test",
    keywords: ["test", "testing", "failure"],
  },
  {
    re: /AssertionError/i,
    category: "test",
    keywords: ["test", "assertion", "testing"],
  },
  {
    re: /Expected[\s\S]*?Received/i,
    category: "test",
    keywords: ["test", "testing", "assertion"],
  },
  {
    re: /pytest.*FAILED/i,
    category: "test",
    keywords: ["pytest", "python", "testing"],
  },
  {
    re: /ERRORS? SUMMARY/i,
    category: "test",
    keywords: ["test", "testing", "failure"],
  },

  {
    re: /Build failed/i,
    category: "build",
    keywords: ["build", "compile", "bundle"],
  },
  {
    re: /Compilation error/i,
    category: "build",
    keywords: ["build", "compile", "typescript"],
  },
  {
    re: /ERROR in .*webpack/i,
    category: "build",
    keywords: ["build", "webpack", "bundle"],
  },
  {
    re: /vite.*error/i,
    category: "build",
    keywords: ["build", "vite", "bundle"],
  },
  {
    re: /esbuild.*error/i,
    category: "build",
    keywords: ["build", "esbuild", "bundle"],
  },

  {
    re: /relation ".*" does not exist/i,
    category: "database",
    keywords: ["database", "sql", "postgres", "migration"],
  },
  {
    re: /SQLITE_ERROR/i,
    category: "database",
    keywords: ["database", "sqlite", "sql"],
  },
  {
    re: /duplicate key/i,
    category: "database",
    keywords: ["database", "sql", "constraint"],
  },
  {
    re: /migration.*fail/i,
    category: "database",
    keywords: ["database", "migration", "schema"],
  },

  {
    re: /docker.*error/i,
    category: "docker",
    keywords: ["docker", "container", "devops"],
  },
  {
    re: /ENOENT.*docker/i,
    category: "docker",
    keywords: ["docker", "container"],
  },
  {
    re: /OCI runtime/i,
    category: "docker",
    keywords: ["docker", "container", "runtime"],
  },

  {
    re: /\bCORS\b.{0,40}\b(error|block|policy|origin|denied)/i,
    category: "security",
    keywords: ["security", "cors", "http", "api"],
  },
  {
    re: /Access-Control-Allow/i,
    category: "security",
    keywords: ["security", "cors", "http"],
  },
  {
    re: /EACCES/i,
    category: "permission",
    keywords: ["permission", "access", "filesystem"],
  },
  {
    re: /permission denied/i,
    category: "permission",
    keywords: ["permission", "access"],
  },

  {
    re: /ECONNREFUSED/i,
    category: "network",
    keywords: ["network", "connection", "api", "server"],
  },
  {
    re: /fetch failed/i,
    category: "network",
    keywords: ["network", "fetch", "http", "api"],
  },
  {
    re: /ETIMEDOUT/i,
    category: "network",
    keywords: ["network", "timeout", "connection"],
  },
  {
    re: /ERR_CONNECTION/i,
    category: "network",
    keywords: ["network", "connection"],
  },
];
