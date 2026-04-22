import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isRetryableError } from "./error-classifier"
import { createFallbackState } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { isAbortError } from "../../shared/is-abort-error"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { createSessionStatusHandler } from "./session-status-handler"
import {
  isMeridianAuthError,
  isMeridianQuotaError,
  tryRecoverMeridianAuth,
  isMeridianSubscriptionError,
  tryReassignMeridianProfileWithReason,
  classifyQuotaKind,
  parseResetAt,
} from "./meridian-auth-recovery"

/**
 * Best-effort: extract the textual error message from a variety of shapes
 * the runtime may throw (string, Error, opencode error envelope).
 */
function stringifyError(err: unknown): string {
  if (!err) return ""
  if (typeof err === "string") return err
  if (err instanceof Error) return err.message
  if (typeof err === "object") {
    const anyErr = err as { message?: unknown; error?: unknown; description?: unknown }
    if (typeof anyErr.message === "string") return anyErr.message
    if (typeof anyErr.error === "string") return anyErr.error
    if (typeof anyErr.description === "string") return anyErr.description
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const { config, pluginConfig, sessionStates, sessionLastAccess, sessionRetryInFlight, sessionAwaitingFallbackResult, sessionFallbackTimeouts, sessionStatusRetryKeys } = deps
  const sessionStatusHandler = createSessionStatusHandler(deps, helpers, sessionStatusRetryKeys)
  const cancelledSessions = new Set<string>()

  const resetRetryState = (sessionID: string) => {
    const state = sessionStates.get(sessionID)
    if (state) {
      sessionStates.set(sessionID, createFallbackState(state.originalModel))
    }

    sessionRetryInFlight.delete(sessionID)
    sessionAwaitingFallbackResult.delete(sessionID)
    sessionStatusRetryKeys.delete(sessionID)
    helpers.clearSessionFallbackTimeout(sessionID)
  }

  const handleSessionCreated = (props: Record<string, unknown> | undefined) => {
    const sessionInfo = props?.info as { id?: string; model?: string } | undefined
    const sessionID = sessionInfo?.id
    const model = sessionInfo?.model

    if (sessionID && model) {
      log(`[${HOOK_NAME}] Session created with model`, { sessionID, model })
      sessionStates.set(sessionID, createFallbackState(model))
      sessionLastAccess.set(sessionID, Date.now())
    }
  }

  const handleSessionDeleted = (props: Record<string, unknown> | undefined) => {
    const sessionInfo = props?.info as { id?: string } | undefined
    const sessionID = sessionInfo?.id

    if (sessionID) {
      log(`[${HOOK_NAME}] Cleaning up session state`, { sessionID })
      cancelledSessions.delete(sessionID)
      sessionStates.delete(sessionID)
      sessionLastAccess.delete(sessionID)
      sessionRetryInFlight.delete(sessionID)
      sessionAwaitingFallbackResult.delete(sessionID)
      helpers.clearSessionFallbackTimeout(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      SessionCategoryRegistry.remove(sessionID)
    }
  }

  const handleSessionStop = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
      await helpers.abortSessionRequest(sessionID, "session.stop")
    }

    cancelledSessions.add(sessionID)
    resetRetryState(sessionID)

    log(`[${HOOK_NAME}] Cleared fallback retry state on session.stop`, { sessionID })
  }

  const handleMessageUpdated = (props: Record<string, unknown> | undefined) => {
    const info = props?.info as Record<string, unknown> | undefined
    const sessionID = info?.sessionID as string | undefined
    const role = info?.role as string | undefined
    if (!sessionID || role !== "user") return

    cancelledSessions.delete(sessionID)
  }

  const handleSessionIdle = (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    if (cancelledSessions.has(sessionID)) {
      resetRetryState(sessionID)
      log(`[${HOOK_NAME}] Cleared fallback retry state for cancelled session on idle`, { sessionID })
      return
    }

    if (sessionAwaitingFallbackResult.has(sessionID)) {
      log(`[${HOOK_NAME}] session.idle while awaiting fallback result; keeping timeout armed`, { sessionID })
      return
    }

    const hadTimeout = sessionFallbackTimeouts.has(sessionID)
    helpers.clearSessionFallbackTimeout(sessionID)
    sessionRetryInFlight.delete(sessionID)
    sessionStatusRetryKeys.delete(sessionID)

    const state = sessionStates.get(sessionID)
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined
    }

    if (hadTimeout) {
      log(`[${HOOK_NAME}] Cleared fallback timeout after session completion`, { sessionID })
    }
  }

  const handleSessionError = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    const error = props?.error
    const agent = props?.agent as string | undefined

    if (!sessionID) {
      log(`[${HOOK_NAME}] session.error without sessionID, skipping`)
      return
    }

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)

    if (isAbortError(error)) {
      cancelledSessions.add(sessionID)
      resetRetryState(sessionID)
      log(`[${HOOK_NAME}] session.error matched cancellation; cleared retry state`, { sessionID, resolvedAgent })
      return
    }

    if (sessionRetryInFlight.has(sessionID)) {
      log(`[${HOOK_NAME}] session.error skipped - retry in flight`, {
        sessionID,
        retryInFlight: true,
      })
      return
    }

    sessionAwaitingFallbackResult.delete(sessionID)
    helpers.clearSessionFallbackTimeout(sessionID)

    log(`[${HOOK_NAME}] session.error received`, {
      sessionID,
      agent,
      resolvedAgent,
      statusCode: extractStatusCode(error, config.retry_on_errors),
      errorName: extractErrorName(error),
      errorType: classifyErrorType(error),
    })

    if (!isRetryableError(error, config.retry_on_errors)) {
      log(`[${HOOK_NAME}] Error not retryable, skipping fallback`, {
        sessionID,
        retryable: false,
        statusCode: extractStatusCode(error, config.retry_on_errors),
        errorName: extractErrorName(error),
        errorType: classifyErrorType(error),
      })
      return
    }

    // Meridian profile recovery — cheaper than model fallback: if the
    // failure is profile-specific (auth expired, weekly/hourly quota
    // exhausted, 429 rate-limit), force a profile switch via the
    // multi-profile plugin and retry with the SAME model. Other profiles
    // may still have budget. Falls through to model fallback if reassign
    // fails or no healthy profile remains.
    let state = sessionStates.get(sessionID)
    const quotaKind = classifyQuotaKind(error)
    const errText = stringifyError(error)
    const resetAt = quotaKind ? parseResetAt(errText) : null
    // Forward resetAt to the AccountPool so the sidebar can show "resets in 4h"
    // with the real reset time instead of a generic 5-minute cooldown.
    if (quotaKind) {
      try {
        const reg = globalThis as unknown as {
          __accountPoolMarkSessionLimit?: (
            providerID: string,
            accountIndex: number,
            kind: "5h" | "weekly",
            resetAt: number,
          ) => void
          __accountPoolActive?: (providerID: string) => number | null
        }
        if (resetAt && typeof reg.__accountPoolMarkSessionLimit === "function") {
          const activeIdx = reg.__accountPoolActive?.("anthropic") ?? 0
          reg.__accountPoolMarkSessionLimit("anthropic", activeIdx, quotaKind, resetAt)
        }
      } catch (err) {
        log(`[${HOOK_NAME}] failed to mark session limit on pool`, { error: String(err) })
      }
    }
    const meridianReason = isMeridianSubscriptionError(error)
      ? "no_subscription"
      : isMeridianAuthError(error)
        ? "auth_expired"
        : quotaKind === "weekly"
          ? "weekly_limit"
          : quotaKind === "5h"
            ? "rate_limit"
            : null
    if (meridianReason) {
      // Refresh-first: for auth_expired, try OAuth refresh on any
      // auth_expired profile BEFORE rotating. Refresh is cheap
      // (single-flight at the plugin) and recovers the common case
      // where the access_token expired mid-session but the refresh_token
      // is still valid. Rotating to a new profile when we could've just
      // refreshed bleeds session affinity unnecessarily.
      let newProfile: string | null = null
      if (meridianReason === "auth_expired") {
        const recovery = await tryRecoverMeridianAuth(sessionID)
        if (recovery.outcome === "refreshed") {
          // Profile was refreshed in place; pick() will select it again.
          // Retry with the same sessionID — no reassign needed.
          const retryModel = state?.originalModel ?? resolveFallbackBootstrapModel({
            sessionID,
            source: `meridian-auth-refresh-recovery`,
            eventModel: props?.model as string | undefined,
            resolvedAgent,
            pluginConfig,
          })
          if (retryModel) {
            log(`[${HOOK_NAME}] Retrying after Meridian OAuth refresh (no rotation)`, {
              sessionID,
              retryModel,
            })
            if (!state) {
              state = createFallbackState(retryModel)
              sessionStates.set(sessionID, state)
            }
            sessionLastAccess.set(sessionID, Date.now())
            await helpers.autoRetryWithFallback(
              sessionID,
              retryModel,
              resolvedAgent,
              `meridian-auth-refresh-recovery`,
            )
            return
          }
        }
        newProfile = recovery.profile
      }
      if (!newProfile) {
        newProfile = tryReassignMeridianProfileWithReason(sessionID, meridianReason)
      }
      if (newProfile) {
        const retryModel = state?.originalModel ?? resolveFallbackBootstrapModel({
          sessionID,
          source: `meridian-${meridianReason}-recovery`,
          eventModel: props?.model as string | undefined,
          resolvedAgent,
          pluginConfig,
        })
        if (retryModel) {
          log(`[${HOOK_NAME}] Retrying after Meridian profile reassign`, {
            sessionID,
            reason: meridianReason,
            newProfile,
            retryModel,
          })
          if (!state) {
            state = createFallbackState(retryModel)
            sessionStates.set(sessionID, state)
          }
          sessionLastAccess.set(sessionID, Date.now())
          await helpers.autoRetryWithFallback(
            sessionID,
            retryModel,
            resolvedAgent,
            `meridian-${meridianReason}-recovery`,
          )
          return
        }
      }
      // No healthy profile — fall through to model fallback as last resort.
      log(`[${HOOK_NAME}] Meridian reassign unavailable; falling through to model fallback`, {
        sessionID,
        reason: meridianReason,
      })
    }

    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

    if (fallbackModels.length === 0) {
      log(`[${HOOK_NAME}] No fallback models configured`, { sessionID, agent })
      return
    }

    if (!state) {
      const initialModel = resolveFallbackBootstrapModel({
        sessionID,
        source: "session.error",
        eventModel: props?.model as string | undefined,
        resolvedAgent,
        pluginConfig,
      })
      if (!initialModel) {
        log(`[${HOOK_NAME}] No model info available, cannot fallback`, { sessionID })
        return
      }

      state = createFallbackState(initialModel)
      sessionStates.set(sessionID, state)
      sessionLastAccess.set(sessionID, Date.now())
    } else {
      sessionLastAccess.set(sessionID, Date.now())
    }

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels,
      resolvedAgent,
      source: "session.error",
    })
  }

  return async ({ event }: { event: { type: string; properties?: unknown } }) => {
    if (!config.enabled) return

    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.created") { handleSessionCreated(props); return }
    if (event.type === "session.deleted") { handleSessionDeleted(props); return }
    if (event.type === "session.stop") { await handleSessionStop(props); return }
    if (event.type === "message.updated") { handleMessageUpdated(props); return }
    if (event.type === "session.idle") { handleSessionIdle(props); return }
    if (event.type === "session.status") { await sessionStatusHandler(props); return }
    if (event.type === "session.error") { await handleSessionError(props); return }
  }
}
