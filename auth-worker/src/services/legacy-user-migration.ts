import {
  listDescendantGroups,
  listTopLevelGroups,
  listUserMemberships,
  type GitLabGroupRaw,
} from "../../../src/lib/migrate/gitlab/api"
import type { GitLabCredentials } from "../../../src/lib/migrate/gitlab/auth"
import type { GitLabSubgroupNode } from "../../../src/lib/migrate/groups"
import {
  planCanonicalUserAccess,
  type CanonicalUserAccessPlan,
  type ExistingAccessTargets,
} from "../../../src/lib/migrate/user-access"
import {
  FRONTIER_D1_SOURCE,
  findLegacyUsersByIdentifier,
  type FrontierD1Config,
  type LegacyUserRow,
} from "./frontier-d1"
import {
  isBcryptHash,
  isWerkzeugScryptHash,
  parseWerkzeugScryptHash,
  verifyPassword,
} from "../utils/password"
import type { AquillaDb } from "../../../db/shim/postgres"

export type LegacyMigrationFailure =
  | "conflict"
  | "dependency"
  | "unresolved-access"
  | "unsupported-hash"

export class LegacyUserMigrationError extends Error {
  readonly code: LegacyMigrationFailure

  constructor(
    code: LegacyMigrationFailure,
    message: string,
  ) {
    super(message)
    this.name = "LegacyUserMigrationError"
    this.code = code
  }
}

export interface GitLabAccessTopology {
  topGroups: GitLabGroupRaw[]
  subgroups: GitLabSubgroupNode[]
}

export interface LegacyMigrationContext {
  topology: GitLabAccessTopology
  existing: ExistingAccessTargets
}

export interface LegacyMigrationRuntime {
  d1: FrontierD1Config
  gitlab: GitLabCredentials
}

export interface LegacyMigrationResult {
  userId: number
  username: string
  created: boolean
}

function timestampOrNull(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function assertSupportedLegacyHash(hash: string): void {
  try {
    if (isWerkzeugScryptHash(hash)) {
      parseWerkzeugScryptHash(hash)
      return
    }
    if (isBcryptHash(hash) && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
      return
    }
  } catch {
    // The sanitized unsupported-hash result below covers malformed scrypt.
  }
  throw new LegacyUserMigrationError(
    "unsupported-hash",
    "legacy user has an unsupported password hash",
  )
}

export async function loadGitLabAccessTopology(
  gitlab: GitLabCredentials,
): Promise<GitLabAccessTopology> {
  try {
    const topGroups = await listTopLevelGroups(gitlab)
    const descendantSets = await Promise.all(
      topGroups.map(async (top) => ({
        top,
        descendants: await listDescendantGroups(gitlab, top.id),
      })),
    )
    return {
      topGroups,
      subgroups: descendantSets.flatMap(({ top, descendants }) =>
        descendants.map((group) => ({
          id: group.id,
          name: group.name,
          full_path: group.full_path,
          topLevelId: top.id,
        })),
      ),
    }
  } catch {
    throw new LegacyUserMigrationError(
      "dependency",
      "GitLab access topology is unavailable",
    )
  }
}

export async function loadExistingAccessTargets(
  db: AquillaDb,
): Promise<ExistingAccessTargets> {
  const [orgs, teams, projects] = await Promise.all([
    db.prepare(
      "SELECT legacy_uuid FROM organizations WHERE legacy_uuid IS NOT NULL",
    ).all<{ legacy_uuid: string }>(),
    db.prepare(
      "SELECT legacy_uuid FROM groups WHERE legacy_uuid IS NOT NULL",
    ).all<{ legacy_uuid: string }>(),
    db.prepare("SELECT id FROM projects").all<{ id: string }>(),
  ])
  return {
    orgUuids: new Set(orgs.results.map((row) => row.legacy_uuid)),
    teamUuids: new Set(teams.results.map((row) => row.legacy_uuid)),
    projectIds: new Set(projects.results.map((row) => row.id)),
  }
}

export async function prepareLegacyUserAccess(
  source: LegacyUserRow,
  gitlab: GitLabCredentials,
  context: LegacyMigrationContext,
): Promise<CanonicalUserAccessPlan> {
  if (source.gitlab_user_id == null) {
    throw new LegacyUserMigrationError(
      "unresolved-access",
      "legacy user has no GitLab identity",
    )
  }
  let memberships
  try {
    memberships = await listUserMemberships(gitlab, source.gitlab_user_id)
  } catch {
    throw new LegacyUserMigrationError(
      "dependency",
      "GitLab user memberships are unavailable",
    )
  }
  const plan = planCanonicalUserAccess({
    username: source.username,
    topGroups: context.topology.topGroups,
    subgroups: context.topology.subgroups,
    memberships,
    existing: context.existing,
  })
  if (plan.conflicts.length > 0) {
    throw new LegacyUserMigrationError(
      "unresolved-access",
      `canonical access plan has ${plan.conflicts.length} unresolved target(s)`,
    )
  }
  return plan
}

async function findIdempotentResult(
  db: AquillaDb,
  source: LegacyUserRow,
): Promise<LegacyMigrationResult | null> {
  const identity = await db.prepare(
    `SELECT id, username, email
       FROM users
      WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
      ORDER BY id`,
  ).bind(source.username, source.email).all<{
    id: number
    username: string
    email: string
  }>()
  if (identity.results.length !== 1) return null
  const row = identity.results[0]
  if (
    row.username.toLowerCase() !== source.username.toLowerCase() ||
    row.email.toLowerCase() !== source.email.toLowerCase()
  ) {
    return null
  }
  const link = await db.prepare(
    `SELECT neon_user_id
       FROM legacy_identity_links
      WHERE source = ? AND source_user_id = ?`,
  ).bind(FRONTIER_D1_SOURCE, source.id).first<{ neon_user_id: number }>()
  if (!link || Number(link.neon_user_id) !== Number(row.id)) return null
  return { userId: Number(row.id), username: row.username, created: false }
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string }
  return candidate?.code === "23505" ||
    String(candidate?.message ?? error).includes("duplicate key value")
}

export async function applyLegacyUserMigration(
  db: AquillaDb,
  source: LegacyUserRow,
  access: CanonicalUserAccessPlan,
  importedVia: "jit" | "scheduled",
): Promise<LegacyMigrationResult> {
  assertSupportedLegacyHash(source.password_hash)
  if (!source.username.trim() || !source.email.trim() || source.gitlab_user_id == null) {
    throw new LegacyUserMigrationError(
      "conflict",
      "legacy identity is missing a required field",
    )
  }
  if (access.conflicts.length > 0) {
    throw new LegacyUserMigrationError(
      "unresolved-access",
      "legacy access plan is incomplete",
    )
  }
  if (!db.transaction) {
    throw new LegacyUserMigrationError(
      "dependency",
      "atomic Postgres transactions are unavailable",
    )
  }

  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.prepare(
        `SELECT id, username, email
           FROM users
          WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
          ORDER BY id
          FOR UPDATE`,
      ).bind(source.username, source.email).all<{
        id: number
        username: string
        email: string
      }>()
      if (existing.results.length > 0) {
        const idempotent = await findIdempotentResult(tx, source)
        if (idempotent) return idempotent
        throw new LegacyUserMigrationError(
          "conflict",
          "legacy identity collides with an existing Neon identity",
        )
      }

      const inserted = await tx.prepare(
        `INSERT INTO users (
           username, email, password_hash, preferences, created_at, updated_at
         ) VALUES (
           ?, ?, ?, '{}', COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP)
         )
         RETURNING id`,
      ).bind(
        source.username,
        source.email,
        source.password_hash,
        timestampOrNull(source.created_at),
        timestampOrNull(source.updated_at),
      ).first<{ id: number }>()
      if (!inserted) {
        throw new Error("Neon did not return the inserted user id")
      }
      const userId = Number(inserted.id)

      await tx.prepare(
        `INSERT INTO legacy_identity_links (
           source, source_user_id, neon_user_id, source_username, source_email,
           gitlab_user_id, imported_via
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        FRONTIER_D1_SOURCE,
        source.id,
        userId,
        source.username,
        source.email,
        source.gitlab_user_id,
        importedVia,
      ).run()

      for (const membership of access.orgMemberships) {
        const org = await tx.prepare(
          "SELECT id FROM organizations WHERE legacy_uuid = ?",
        ).bind(membership.orgUuid).first<{ id: number }>()
        if (!org) throw new Error("planned organization disappeared")
        await tx.prepare(
          `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
           VALUES (?, ?, ?, NULL)
           ON CONFLICT (org_id, user_id)
           DO UPDATE SET role_level = excluded.role_level`,
        ).bind(org.id, userId, membership.roleLevel).run()
      }

      for (const teamUuid of access.teamUuids) {
        const team = await tx.prepare(
          "SELECT id FROM groups WHERE legacy_uuid = ?",
        ).bind(teamUuid).first<{ id: number }>()
        if (!team) throw new Error("planned group disappeared")
        await tx.prepare(
          `INSERT INTO group_members (group_id, user_id, added_by)
           VALUES (?, ?, NULL)
           ON CONFLICT (group_id, user_id) DO NOTHING`,
        ).bind(team.id, userId).run()
      }

      for (const membership of access.projectMemberships) {
        const project = await tx.prepare(
          "SELECT id FROM projects WHERE id = ?",
        ).bind(membership.projectId).first<{ id: string }>()
        if (!project) throw new Error("planned project disappeared")
        await tx.prepare(
          `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
           VALUES (?, ?, ?, NULL)
           ON CONFLICT (project_id, user_id)
           DO UPDATE SET role_level = excluded.role_level`,
        ).bind(project.id, userId, membership.roleLevel).run()
      }

      await tx.prepare(
        `INSERT INTO activity_logs (user_id, activity_type, description)
         VALUES (?, 'legacy_user_migrated', 'Imported from frontier-db-v2')`,
      ).bind(userId).run()

      return { userId, username: source.username, created: true }
    })
  } catch (error) {
    if (error instanceof LegacyUserMigrationError) throw error
    if (isUniqueViolation(error)) {
      const idempotent = await findIdempotentResult(db, source)
      if (idempotent) return idempotent
      throw new LegacyUserMigrationError(
        "conflict",
        "legacy identity collided during migration",
      )
    }
    throw new LegacyUserMigrationError(
      "dependency",
      "atomic legacy user migration failed",
    )
  }
}

export async function migrateLegacyUserCandidate(
  db: AquillaDb,
  source: LegacyUserRow,
  runtime: LegacyMigrationRuntime,
  importedVia: "jit" | "scheduled",
  context?: LegacyMigrationContext,
): Promise<LegacyMigrationResult> {
  const resolvedContext = context ?? {
    topology: await loadGitLabAccessTopology(runtime.gitlab),
    existing: await loadExistingAccessTargets(db),
  }
  const access = await prepareLegacyUserAccess(
    source,
    runtime.gitlab,
    resolvedContext,
  )
  return applyLegacyUserMigration(db, source, access, importedVia)
}

export async function migrateLegacyUserForLogin(
  db: AquillaDb,
  identifier: string,
  password: string,
  runtime: LegacyMigrationRuntime,
  fetchFn: typeof fetch = fetch,
): Promise<LegacyMigrationResult | null> {
  let matches: LegacyUserRow[]
  try {
    matches = await findLegacyUsersByIdentifier(runtime.d1, identifier, fetchFn)
  } catch {
    throw new LegacyUserMigrationError(
      "dependency",
      "frontier-db-v2 lookup is unavailable",
    )
  }
  if (matches.length === 0) return null
  if (matches.length !== 1) {
    throw new LegacyUserMigrationError(
      "conflict",
      "legacy identifier matches multiple source users",
    )
  }
  const source = matches[0]
  assertSupportedLegacyHash(source.password_hash)
  let verified = false
  try {
    verified = (await verifyPassword(password, source.password_hash)).isValid
  } catch {
    verified = false
  }
  if (!verified) return null

  // The submitted identifier can uniquely find one row while that row's other
  // key (username or email) is shared by a second legacy identity. Check both
  // keys after password verification and quarantine the whole collision before
  // any GitLab lookup or Neon write.
  const identifierKey = identifier.trim().toLowerCase()
  const relatedIdentifiers = [...new Set([source.username, source.email])]
    .filter((value) => value.trim().toLowerCase() !== identifierKey)
  try {
    const related = await Promise.all(
      relatedIdentifiers.map((value) =>
        findLegacyUsersByIdentifier(runtime.d1, value, fetchFn),
      ),
    )
    const relatedIds = new Set([
      ...matches.map((match) => match.id),
      ...related.flatMap((rows) => rows.map((row) => row.id)),
    ])
    if (relatedIds.size !== 1) {
      throw new LegacyUserMigrationError(
        "conflict",
        "legacy username or email belongs to multiple source identities",
      )
    }
  } catch (error) {
    if (error instanceof LegacyUserMigrationError) throw error
    throw new LegacyUserMigrationError(
      "dependency",
      "frontier-db-v2 identity validation is unavailable",
    )
  }
  return migrateLegacyUserCandidate(db, source, runtime, "jit")
}
