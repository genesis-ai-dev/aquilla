// Global, runtime-editable platform config — the store behind the hardened
// admin console's Settings tab (routes/admin.ts) and the chat/agent model +
// budget resolution (routes/chat.ts, routes/agent.ts, lib/ai-budget.ts).
//
// Design mirrors org_settings (routes/org-settings.ts): one versioned JSON row
// with optimistic-concurrency writes. The difference is scope — there is only
// ever ONE row (id = 1), holding platform-wide defaults.
//
// Every key is optional; an unset key means "fall back to the wrangler.toml env
// var / hardcoded default" at the read site. So configuring nothing keeps the
// exact behaviour we had before this store existed.
//
// HOT PATH: getPlatformSettingsCached() is read on every chat/agent request, so
// it caches in-isolate for ~30s (no KV is available to this worker). The
// tradeoff: a settings change propagates within TTL_MS. The cache is bypassed
// under ENVIRONMENT=test so PGlite truncation between tests can't leak stale
// settings, and is invalidated immediately on save.

import type { Env } from "../types"

export interface PlatformSettings {
  /** Default model for /chat/completions when the client sends ""/"default"/"free-tier". */
  defaultLlmModel?: string
  /** Model the translation agent runs on (routes/agent.ts). */
  agentModel?: string
  /** Allowlist of model IDs accepted by the AI guard (lib/ai-budget.ts). */
  allowedModels?: string[]
  /** Max AI requests per user per UTC day. */
  aiUserDailyLimit?: number
  /** Aggregate AI requests across all users per UTC day. */
  aiGlobalDailyLimit?: number
  /** When true, the AI budget is enforced with 429s instead of log-only. */
  aiBudgetEnforce?: boolean
}

export interface PlatformSettingsRecord {
  settings: PlatformSettings
  version: number
  updatedAt: string | null
  updatedBy: number | null
}

interface PlatformSettingsRow {
  id: number
  settings: string
  version: number
  updated_at: string | null
  updated_by: number | null
}

/** Parse the stored JSON blob, keeping only well-typed known keys. */
function parseSettings(raw: string): PlatformSettings {
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    obj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
  } catch {
    return {}
  }
  const out: PlatformSettings = {}
  if (typeof obj.defaultLlmModel === "string") out.defaultLlmModel = obj.defaultLlmModel
  if (typeof obj.agentModel === "string") out.agentModel = obj.agentModel
  if (Array.isArray(obj.allowedModels)) {
    out.allowedModels = obj.allowedModels.filter((m): m is string => typeof m === "string")
  }
  if (typeof obj.aiUserDailyLimit === "number") out.aiUserDailyLimit = obj.aiUserDailyLimit
  if (typeof obj.aiGlobalDailyLimit === "number") out.aiGlobalDailyLimit = obj.aiGlobalDailyLimit
  if (typeof obj.aiBudgetEnforce === "boolean") out.aiBudgetEnforce = obj.aiBudgetEnforce
  return out
}

/** Read the single platform_settings row (id = 1); empty record if none yet. */
export async function loadPlatformSettings(env: Env): Promise<PlatformSettingsRecord> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT id, settings, version, updated_at, updated_by
       FROM platform_settings
      WHERE id = 1`,
  ).first<PlatformSettingsRow>()

  if (!row) return { settings: {}, version: 0, updatedAt: null, updatedBy: null }
  return {
    settings: parseSettings(row.settings),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

// ── Hot-path cache (in-isolate, ~30s) ────────────────────────────────────────

const TTL_MS = 30_000
let cache: { value: PlatformSettings; at: number } | null = null
let inflight: Promise<PlatformSettings> | null = null

/**
 * Cached settings read for the chat/agent hot path. Bypasses the cache under
 * ENVIRONMENT=test (PGlite resets between tests). On a read error it degrades
 * to {} (env fallbacks apply downstream) without poisoning the cache.
 */
export async function getPlatformSettingsCached(env: Env): Promise<PlatformSettings> {
  if (env.ENVIRONMENT === "test") {
    return (await loadPlatformSettings(env)).settings
  }
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache.value
  if (inflight) return inflight
  inflight = loadPlatformSettings(env)
    .then((rec) => {
      cache = { value: rec.settings, at: Date.now() }
      return rec.settings
    })
    .catch((err) => {
      console.error("[platform-settings] load failed (using env fallbacks):", err)
      return {} as PlatformSettings
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Drop the in-isolate cache so the next read re-fetches. Called on save. */
export function invalidatePlatformSettingsCache(): void {
  cache = null
  inflight = null
}

export type SavePlatformSettingsResult =
  | { ok: true; record: PlatformSettingsRecord }
  | { ok: false; conflict: PlatformSettingsRecord }

/**
 * Shallow-merge `patch` into the stored settings under an optimistic-version
 * guard (mirrors org-settings). Returns { ok: false, conflict } on a version
 * mismatch so the caller can 409 with the current row.
 */
export async function savePlatformSettings(
  env: Env,
  patch: PlatformSettings,
  ifMatchVersion: number,
  userId: number,
): Promise<SavePlatformSettingsResult> {
  const current = await loadPlatformSettings(env)
  if (ifMatchVersion !== current.version) {
    return { ok: false, conflict: current }
  }

  const merged: PlatformSettings = { ...current.settings, ...patch }
  const json = JSON.stringify(merged)
  const newVersion = current.version + 1

  if (current.updatedAt == null) {
    try {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO platform_settings (id, settings, version, updated_by)
         VALUES (1, ?, ?, ?)`,
      )
        .bind(json, newVersion, userId)
        .run()
    } catch {
      // Concurrent insert won the race — surface the fresh row as a conflict.
      return { ok: false, conflict: await loadPlatformSettings(env) }
    }
  } else {
    const result = await env.AQUILLA_PG.prepare(
      `UPDATE platform_settings
          SET settings = ?, version = version + 1, updated_at = now(), updated_by = ?
        WHERE id = 1 AND version = ?`,
    )
      .bind(json, userId, ifMatchVersion)
      .run()
    const changes = result.meta?.changes
    if (typeof changes === "number" && changes === 0) {
      return { ok: false, conflict: await loadPlatformSettings(env) }
    }
  }

  invalidatePlatformSettingsCache()
  return { ok: true, record: await loadPlatformSettings(env) }
}
