#!/usr/bin/env tsx
// AQU-713: atomic frontier-db-v2 → Neon identity + access migration.
//
// Dry-run is the default. Writes require --apply:
//   npx tsx scripts/migrate-users.ts
//   npx tsx scripts/migrate-users.ts --apply
//   npx tsx scripts/migrate-users.ts --apply --limit 25
//
// Required environment:
//   NEON_PG_*                     target Neon connection
//   FRONTIER_D1_ACCOUNT_ID
//   FRONTIER_D1_DATABASE_ID
//   FRONTIER_D1_API_TOKEN         D1 Read only
//   FRONTIER_TOKEN + GITLAB_URL   trusted GitLab administrator credential

import type { Client } from "pg"
import { neonClient } from "./pg"
import {
  PostgresDb,
  type PgExecutor,
} from "../db/shim/postgres"
import {
  listAllLegacyUsers,
  type FrontierD1Config,
  type LegacyUserRow,
} from "../auth-worker/src/services/frontier-d1"
import {
  LegacyUserMigrationError,
  applyLegacyUserMigration,
  assertSupportedLegacyHash,
  loadExistingAccessTargets,
  loadGitLabAccessTopology,
  prepareLegacyUserAccess,
} from "../auth-worker/src/services/legacy-user-migration"
import { resolveCredentialsFromEnv } from "../src/lib/migrate/gitlab/auth"
import {
  planUserImport,
  type ExistingUser,
  type SourceUser,
} from "../src/lib/migrate/users"

interface Args {
  apply: boolean
  limit: number | null
}

function parseArgs(argv = process.argv.slice(2)): Args {
  let apply = false
  let limit: number | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") {
      apply = true
      continue
    }
    if (argv[i] === "--limit") {
      const parsed = Number(argv[++i])
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("--limit requires a positive integer")
      }
      limit = parsed
      continue
    }
    throw new Error(`unknown argument: ${argv[i]}`)
  }
  return { apply, limit }
}

function d1ConfigFromEnv(): FrontierD1Config {
  const accountId = process.env.FRONTIER_D1_ACCOUNT_ID?.trim()
  const databaseId = process.env.FRONTIER_D1_DATABASE_ID?.trim()
  const apiToken = process.env.FRONTIER_D1_API_TOKEN?.trim()
  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      "FRONTIER_D1_ACCOUNT_ID, FRONTIER_D1_DATABASE_ID, and " +
      "FRONTIER_D1_API_TOKEN (D1 Read only) are required",
    )
  }
  return { accountId, databaseId, apiToken }
}

function pgExecutor(client: Client): PgExecutor {
  const executor: PgExecutor = {
    async run(sql, params) {
      const result = await client.query<Record<string, unknown>>(sql, params)
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
    },
    async begin<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T> {
      await client.query("BEGIN")
      try {
        const result = await fn(executor)
        await client.query("COMMIT")
        return result
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      }
    },
  }
  return executor
}

const identityKey = (user: Pick<SourceUser, "username" | "email">): string =>
  `${user.username.trim().toLowerCase()}\u0000${user.email.trim().toLowerCase()}`

function sourceForPlan(
  planned: SourceUser[],
  source: LegacyUserRow[],
): LegacyUserRow[] {
  const keys = new Set(planned.map(identityKey))
  return source.filter((user) => keys.has(identityKey(user)))
}

async function main(): Promise<void> {
  const args = parseArgs()
  const d1 = d1ConfigFromEnv()
  const gitlab = await resolveCredentialsFromEnv()
  const client = neonClient()
  await client.connect()
  const db = new PostgresDb(pgExecutor(client))

  const counts = {
    source: 0,
    alreadyPresent: 0,
    conflicted: 0,
    unsupportedHash: 0,
    unresolved: 0,
    planned: 0,
    imported: 0,
    idempotent: 0,
    failed: 0,
  }

  try {
    const [source, existingRows] = await Promise.all([
      listAllLegacyUsers(d1),
      db.prepare(
        "SELECT id, username, email FROM users ORDER BY id",
      ).all<ExistingUser & { id: number }>(),
    ])
    counts.source = source.length
    const identityPlan = planUserImport(
      source,
      existingRows.results,
    )
    counts.alreadyPresent = identityPlan.alreadyPresent
    counts.conflicted = identityPlan.conflicts.length

    let candidates = sourceForPlan(identityPlan.toInsert, source)
    const supported: LegacyUserRow[] = []
    for (const candidate of candidates) {
      try {
        assertSupportedLegacyHash(candidate.password_hash)
        if (candidate.gitlab_user_id == null) {
          counts.unresolved++
          continue
        }
        supported.push(candidate)
      } catch (error) {
        if (
          error instanceof LegacyUserMigrationError &&
          error.code === "unsupported-hash"
        ) {
          counts.unsupportedHash++
          continue
        }
        throw error
      }
    }
    candidates = args.limit == null ? supported : supported.slice(0, args.limit)

    if (candidates.length === 0) {
      console.log(JSON.stringify({
        mode: args.apply ? "apply" : "dry-run",
        ...counts,
      }))
      return
    }

    // Load topology and target identities once. Per-user work only queries the
    // GitLab direct-membership endpoint, then runs the shared pure planner.
    const context = {
      topology: await loadGitLabAccessTopology(gitlab),
      existing: await loadExistingAccessTargets(db),
    }

    for (const candidate of candidates) {
      try {
        const access = await prepareLegacyUserAccess(candidate, gitlab, context)
        counts.planned++
        if (!args.apply) continue
        const result = await applyLegacyUserMigration(
          db,
          candidate,
          access,
          "scheduled",
        )
        if (result.created) counts.imported++
        else counts.idempotent++
      } catch (error) {
        if (
          error instanceof LegacyUserMigrationError &&
          error.code === "conflict"
        ) {
          counts.conflicted++
        } else if (
          error instanceof LegacyUserMigrationError &&
          error.code === "unresolved-access"
        ) {
          counts.unresolved++
        } else {
          counts.failed++
        }
        // Do not emit source ids, usernames, emails, password hashes, tokens,
        // or exception details. Aggregate counts below are the operator report.
        console.error("legacy user candidate status=skipped")
      }
    }

    console.log(JSON.stringify({
      mode: args.apply ? "apply" : "dry-run",
      ...counts,
    }))
    if (counts.failed > 0) process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? `legacy user migration failed: ${error.message}`
      : "legacy user migration failed",
  )
  process.exit(1)
})
