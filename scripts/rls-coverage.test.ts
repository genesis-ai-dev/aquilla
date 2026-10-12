// RLS coverage drift guard (OPSEC review 2026-09-28).
//
// WHY THIS EXISTS. Migration 0034 put a row-level-security backstop on seven
// project-scoped tables and every pass since has cited it as the thing that
// catches a query the application layer scoped wrongly — including the agent
// SQL guard, whose own comments used to delegate its documented residual gap
// to "the RLS backstop where it exists". Nothing ever checked where it exists.
// By 2026-09-28 the schema had 55 project-scoped tables and 21 policies;
// db/postgres/RLS.md still documented nine, one of which (`snapshots`) had been
// dropped 60 migrations earlier. A control nobody measures is a control nobody
// can rely on, so this test measures it:
//
//   * every table with a project_id column is either RLS-covered or listed in
//     UNCOVERED below with a reason, so a new table cannot join the uncovered
//     set silently; and
//   * db/postgres/RLS.md's coverage table matches the migrations, so the doc
//     cannot drift from the schema again.
//
// This is a coverage ledger, not an assertion that RLS is enforced at runtime.
// Whether the deployed Hyperdrive role is subject to policies at all is not
// verifiable from this repo — see RLS.md § Deployment status.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { expectedSchemaContract } from "./neon-schema-contract"

const repoRoot = path.resolve(import.meta.dirname, "..")
const pgDir = path.join(repoRoot, "db/postgres")
const migrationsDir = path.join(pgDir, "migrations")

const schemaSql = readFileSync(path.join(pgDir, "schema.sql"), "utf8")
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
const contract = expectedSchemaContract(
  schemaSql,
  migrationFiles.map((f) => readFileSync(path.join(migrationsDir, f), "utf8")),
)

const projectScoped = [...contract.tables]
  .filter(([, columns]) => columns.has("project_id"))
  .map(([table]) => table)
  .sort()

const rlsCovered = projectScoped.filter((table) => contract.rls.get(table)?.enabled)

/**
 * Project-scoped tables with no RLS policy, and why. Adding a table here is a
 * deliberate decision to leave one layer of defence off it; removing one means
 * a migration gave it a policy.
 *
 * The blanket reason is that extending 0034's pattern is blocked on a question
 * this repo cannot answer (RLS.md § Deployment status): 19 of these tables were
 * never granted to `app_runtime` at all, so the role the workers actually
 * connect as cannot be `app_runtime` — and a policy written `TO app_runtime` is
 * inert for any other role. Two entries have a further, structural reason,
 * called out individually.
 */
const UNCOVERED: Record<string, string> = {
  // Reading either of these is how app_user_can_access_project() decides
  // access, so a policy on them that calls it recurses through itself
  // (SECURITY INVOKER: the function's own reads are subject to the caller's
  // policies). Covering them needs a different policy shape — a self-scoped
  // predicate, or a SECURITY DEFINER helper with a pinned search_path — not a
  // copy of 0034's.
  project_members: "policy would recurse through app_user_can_access_project()",
  group_project_grants: "policy would recurse through app_user_can_access_project()",

  agent_authorizations: "granted to app_runtime, no policy yet",
  assignments: "granted to app_runtime, no policy yet",
  cell_backtranslations: "granted to app_runtime, no policy yet",
  cell_waivers: "granted to app_runtime, no policy yet",
  cell_word_morph: "granted to app_runtime, no policy yet",
  checkpoints: "granted to app_runtime, no policy yet",
  diarization_jobs: "granted to app_runtime, no policy yet",
  file_source_blobs: "granted to app_runtime, no policy yet",
  // 0034's shape does not fit: the OAuth token endpoint redeems a code by its
  // hash with no user in context, and codes issued since 0125 carry org_ids
  // with project_id NULL. Rows hold only the SHA-256 of a five-minute code.
  mcp_oauth_codes: "granted to app_runtime, no policy — redeemed by code hash with no user context (0124/0125)",
  project_invites: "granted to app_runtime, no policy yet — rows are plaintext credentials (OPS-26)",
  project_termbase_subscriptions: "granted to app_runtime, no policy yet",

  agent_memories: "never granted to app_runtime",
  ai_interventions: "never granted to app_runtime",
  agent_read_audit: "never granted to app_runtime",
  agent_runs: "never granted to app_runtime",
  agent_sessions: "never granted to app_runtime",
  api_credentials: "never granted to app_runtime",
  cell_links: "never granted to app_runtime",
  chain_claims: "never granted to app_runtime",
  concepts: "never granted to app_runtime",
  file_segmentation: "never granted to app_runtime",
  integration_links: "never granted to app_runtime",
  knowledge_docs: "never granted to app_runtime",
  lanes: "never granted to app_runtime",
  project_access_links: "never granted to app_runtime — rows are credentials",
  project_brief_history: "never granted to app_runtime",
  project_brief_proposals: "never granted to app_runtime",
  project_briefs: "never granted to app_runtime",
  project_member_lane_roles: "never granted to app_runtime",
  project_member_scopes: "never granted to app_runtime",
  project_seq_counters: "never granted to app_runtime",
  seq_allocations: "never granted to app_runtime",
  // AQU-1694 (0152): derived word links, written like cell_word_morph.
  source_word_alignment: "never granted to app_runtime",
  style_rules: "never granted to app_runtime",
  workspace_usage_requests: "never granted to app_runtime",
}

describe("RLS coverage over project-scoped tables", () => {
  it("accounts for every project-scoped table as covered or explicitly uncovered", () => {
    const unaccounted = projectScoped.filter(
      (table) => !contract.rls.get(table)?.enabled && !(table in UNCOVERED),
    )
    expect(
      unaccounted,
      "new project-scoped table(s) with no RLS policy and no entry in UNCOVERED — " +
        "give them a policy, or record the decision (and the reason) in UNCOVERED",
    ).toEqual([])
  })

  it("does not carry stale UNCOVERED entries", () => {
    const stale = Object.keys(UNCOVERED).filter(
      (table) => !contract.tables.has(table) || contract.rls.get(table)?.enabled,
    )
    expect(stale, "these are covered (or gone) now — drop them from UNCOVERED").toEqual([])
  })

  it("forces RLS wherever it is enabled", () => {
    // ENABLE without FORCE leaves the table owner unfiltered, which is how
    // migrations and admin tooling reach it — but every policy in this schema
    // is written `TO app_runtime`, so a table that is enabled-not-forced is
    // almost certainly a half-written migration.
    const enabledNotForced = rlsCovered.filter((table) => !contract.rls.get(table)?.forced)
    expect(enabledNotForced).toEqual([])
  })

  it("gives every RLS-enabled table at least one policy", () => {
    // ENABLE with no policy denies everything to app_runtime rather than
    // filtering — the silent-zero-rows failure mode RLS.md warns about.
    const policyless = rlsCovered.filter((table) => (contract.policies.get(table)?.size ?? 0) === 0)
    expect(policyless).toEqual([])
  })
})

describe("db/postgres/RLS.md", () => {
  const doc = readFileSync(path.join(pgDir, "RLS.md"), "utf8")

  it("documents every RLS-covered project-scoped table", () => {
    const missing = rlsCovered.filter((table) => !new RegExp(`\`${table}\``).test(doc))
    expect(missing, "RLS.md's coverage table is behind the migrations").toEqual([])
  })

  it("does not claim coverage for a table that has none", () => {
    // `snapshots` sat in this doc's coverage table for 60+ migrations after
    // 0039 dropped the table.
    const overclaimed = [...doc.matchAll(/^\| `([a-z_][a-z0-9_]*)` \| `rls_/gm)]
      .map((match) => match[1])
      .filter((table) => !contract.rls.get(table)?.enabled)
    expect(overclaimed).toEqual([])
  })
})
