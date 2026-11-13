// AQU-2469: only people on an access list can sign in to dev.aquilla.app.
//
// Dev runs untested code against a nightly copy of prod data, so it is closed
// to everyone except:
//   - every platform admin (the `platform_admins` table, which the nightly
//     refresh copies from prod, plus the ADMIN_EMAILS bootstrap), and
//   - the emails on the dev access list.
//
// WHERE THE LIST LIVES. A Cloudflare KV namespace bound as DEV_ACCESS_LIST on
// the dev and preview identity Workers, one key per lower-cased email. Not Postgres:
// the nightly refresh (scripts/refresh-neon-branch.ts) restores the whole Neon
// dev branch from prod, which would wipe a table every night. KV sits outside
// that restore. Admins edit the list under Admin → Platform → Dev access
// (routes/admin-dev-access.ts); `wrangler kv key put` is the backup.
//
// WHERE THE CHECK RUNS. On the Worker named in the deployment manifest as
// the development identity Worker (aquilla-dev-identity). The environment
// guard (environment-guard.ts) already refuses any request on api.dev.aquilla.app
// whose DEPLOYMENT_WORKER_NAME is not that name, so keying on the name covers
// the dev hostname and the Worker's own workers.dev URL alike. Production
// (aquilla-identity), local dev and tests are not gated. Branch previews
// (aquilla-auth-preview) enforce the same list through developmentAccessRequired.
//
// FAIL CLOSED. On dev and preview Workers, a missing binding or a failed KV read refuses
// everyone who is not a platform admin. It never lets them through.
//
// The check runs inside resolveSession (middleware/auth.ts), so every route
// that reads a session (authMiddleware and optionalCaller alike) is covered,
// and the sync worker is covered too: it only accepts sync tokens, which
// POST /sync-token mints behind authMiddleware and which expire in 15 minutes.
// Sign-in and sign-up also check up front (routes/auth.ts) so a refused person
// gets a plain message instead of a token that fails on first use.

import deploymentManifest from "../../../config/cloudflare-deployments.json"
import type { Env } from "../types"
import { isPlatformAdminEmail } from "../middleware/platform-admin"

/** The identity Worker the access list applies to. Read from the manifest so a
 *  rename there cannot silently switch the gate off. */
export const DEV_IDENTITY_WORKER =
  deploymentManifest.surfaces.identity.environments.development.worker

/** Refusal code the SPA keys on (src/lib/frontier/auth.ts). */
export const DEV_ACCESS_RESTRICTED = "dev_access_restricted"

/** What a refused person reads. Plain words: who to ask, not how it works. */
export const DEV_ACCESS_RESTRICTED_MESSAGE =
  "This account doesn’t have access to Aquilla’s development site or CI previews yet. Ask an Aquilla admin to grant access to your account’s email address."

/** Longest email RFC 5321 allows; also caps the KV key length. */
export const DEV_ACCESS_EMAIL_MAX = 254

/** Shape of each KV value. Metadata only; the key is the email. */
export interface DevAccessEntry {
  email: string
  addedBy: string | null
  addedAt: string | null
}

/** True on the dev identity Worker, where the list is enforced. */
export function devAccessGateActive(env: Pick<Env, "DEPLOYMENT_WORKER_NAME">): boolean {
  return env.DEPLOYMENT_WORKER_NAME === DEV_IDENTITY_WORKER
}

export function normalizeDevAccessEmail(email: string): string {
  return email.trim().toLowerCase()
}

export type DevAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "not_listed" | "unavailable" }

/** Preview login is restricted without changing dev-only list management or
 * the admin step-up exemption. Never reuse this predicate to relax elevation. */
export function developmentAccessRequired(env: Pick<Env, "DEPLOYMENT_WORKER_NAME">): boolean {
  return devAccessGateActive(env) || env.DEPLOYMENT_WORKER_NAME === "aquilla-auth-preview"
}

/**
 * Whether `email` may use this deployment. Always allowed where the gate is
 * off. On dev: platform admins first (no KV read), then the list.
 */
export async function checkDevAccess(env: Env, email: string): Promise<DevAccessDecision> {
  if (!developmentAccessRequired(env)) return { allowed: true }
  const normalized = normalizeDevAccessEmail(email)
  if (!normalized) return { allowed: false, reason: "not_listed" }
  // A preview-only QA bootstrap admin is not automatically authorized on dev.
  // It must be explicitly listed unless it is a real database platform admin.
  if (await isPlatformAdminEmail(env, normalized, {
    includeBootstrap: env.DEPLOYMENT_WORKER_NAME !== "aquilla-auth-preview",
  })) return { allowed: true }

  const kv = env.DEV_ACCESS_LIST
  if (!kv) {
    console.error("[dev-access] DEV_ACCESS_LIST is not bound on the dev Worker; failing closed")
    return { allowed: false, reason: "unavailable" }
  }
  try {
    const value = await kv.get(normalized)
    return value === null ? { allowed: false, reason: "not_listed" } : { allowed: true }
  } catch (err) {
    console.error("[dev-access] DEV_ACCESS_LIST read failed; failing closed:", err)
    return { allowed: false, reason: "unavailable" }
  }
}

/** Every listed entry, sorted by email. Throws if the binding is missing. */
export async function listDevAccess(kv: KVNamespace): Promise<DevAccessEntry[]> {
  const entries: DevAccessEntry[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list<Omit<DevAccessEntry, "email">>({ cursor })
    for (const key of page.keys) {
      entries.push({
        email: key.name,
        addedBy: key.metadata?.addedBy ?? null,
        addedAt: key.metadata?.addedAt ?? null,
      })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return entries.sort((a, b) => a.email.localeCompare(b.email))
}

/** Add (or re-add) an email. The metadata rides on the key so a list call
 *  returns it without a read per key. */
export async function addDevAccess(
  kv: KVNamespace,
  email: string,
  addedBy: string,
): Promise<DevAccessEntry> {
  const entry = { addedBy, addedAt: new Date().toISOString() }
  await kv.put(email, JSON.stringify(entry), { metadata: entry })
  return { email, ...entry }
}

export async function removeDevAccess(kv: KVNamespace, email: string): Promise<void> {
  await kv.delete(email)
}
