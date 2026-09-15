// Shared organization row-write logic (AQU-1221). Lives in db/shared/ for the
// same reason as projects.ts: sync-worker's receipt-only `CreateOrg` external
// command and any future auth-worker caller must apply the SAME row writes,
// with no forked logic.
//
// Scope is deliberately narrow — DB writes only. Identity, scope and rate-limit
// gates stay in the caller (sync-worker/src/external/prepare.ts + commit.ts).
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts) so it is callable from
// either worker — the same handle both inject as `env.AQUILLA_PG`.

import type { AquillaDb } from "../shim/postgres"

export interface CreateOrgInput {
  name: string
  /** Creator's user id — becomes the org's owner_user_id AND its 700 member. */
  createdBy: number | string
}

/**
 * Insert an `organizations` row plus the creator's owner-level (700)
 * `org_members` row, atomically, and return the new org id.
 *
 * The two writes ride one statement (a data-modifying CTE) rather than a
 * `batch()`: `organizations.id` is a generated identity column, so the
 * membership insert needs the id the first insert produces. A CTE is the only
 * shape that keeps "org exists" and "creator owns it" indivisible — a caller
 * resolving its role from the membership row must never observe an org without
 * its owner grant.
 *
 * Deliberately writes NOTHING to `org_billing`: an org with no billing row is
 * plan=none, which is exactly the default tier the agent surface is allowed to
 * create (AQU-1221 guardrail — no path to set tier/billing/entitlements).
 *
 * Throws on any DB error; the caller owns the error → HTTP-status mapping.
 */
export async function createOrgShared(
  db: AquillaDb,
  input: CreateOrgInput,
): Promise<{ orgId: number }> {
  const row = await db
    .prepare(
      `WITH new_org AS (
         INSERT INTO organizations (name, owner_user_id)
         VALUES (?, ?)
         RETURNING id
       ), new_member AS (
         INSERT INTO org_members (org_id, user_id, role_level, granted_by)
         SELECT id, ?, 700, ? FROM new_org
         ON CONFLICT (org_id, user_id) DO NOTHING
       )
       SELECT id FROM new_org`,
    )
    .bind(input.name, input.createdBy, input.createdBy, input.createdBy)
    .first<{ id: number }>()
  if (!row) throw new Error("failed to insert organization row")
  return { orgId: Number(row.id) }
}

/**
 * The org this user most recently created under `name`, at or after `since`, or
 * null. Used ONLY to absorb a crash-retry of a `CreateOrg` commit.
 *
 * `organizations.id` is a generated identity column, so — unlike CreateProject,
 * whose client-chosen project id is pinned at prepare (prepare-time-ids
 * doctrine) — a CreateOrg plan cannot carry its definitive id. Without this
 * lookup a commit that inserted the org and then died before writing its
 * receipt would create a SECOND org on retry. The match is narrowed to the
 * creator, the exact planned name, and the changeset's own lifetime, and the
 * caller only consults it for a changeset already in `committing` (i.e. a
 * genuine retry, never a first attempt).
 */
export async function findRecentOrgByCreator(
  db: AquillaDb,
  createdBy: number | string,
  name: string,
  since: string,
): Promise<{ orgId: number } | null> {
  const row = await db
    .prepare(
      `SELECT id FROM organizations
        WHERE owner_user_id = ? AND name = ? AND created_at >= ?
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(createdBy, name, since)
    .first<{ id: number }>()
  return row ? { orgId: Number(row.id) } : null
}
