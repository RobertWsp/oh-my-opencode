import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "../../../shared/logger"

/**
 * Read the Claude Code OAuth credentials from ~/.claude/.credentials.json.
 * Returns null if the file doesn't exist or is malformed. Used by the
 * analyzer to call api.anthropic.com directly, bypassing Meridian's
 * SDK subprocess overhead (sub-second vs 10-20s).
 *
 * We only read; we never modify. Token refresh is handled by the normal
 * Claude Code / Meridian path when the main session needs it.
 */

export interface ClaudeOAuthCredentials {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  subscriptionType?: string
  rateLimitTier?: string
  scopes?: string[]
}

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json")

// Module-level cache to avoid re-reading on every analyzer call
let cached: { creds: ClaudeOAuthCredentials | null; readAt: number } | null = null
const CACHE_TTL_MS = 30_000 // 30s — tokens don't change rapidly

export async function readClaudeOAuthCredentials(): Promise<ClaudeOAuthCredentials | null> {
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
    return cached.creds
  }

  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf-8")
    const parsed = JSON.parse(raw) as { claudeAiOauth?: ClaudeOAuthCredentials }
    const creds = parsed.claudeAiOauth ?? null

    if (!creds || !creds.accessToken) {
      cached = { creds: null, readAt: Date.now() }
      return null
    }

    // Check expiration with a small buffer
    if (creds.expiresAt && creds.expiresAt < Date.now() + 60_000) {
      log("[model-router] Claude OAuth token expired or expiring soon", {
        expiresAt: creds.expiresAt,
      })
      cached = { creds: null, readAt: Date.now() }
      return null
    }

    cached = { creds, readAt: Date.now() }
    return creds
  } catch (e) {
    // File not found, permission denied, parse error — all treated as "no creds"
    cached = { creds: null, readAt: Date.now() }
    return null
  }
}

export function clearCredentialsCache(): void {
  cached = null
}
