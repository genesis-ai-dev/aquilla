#!/usr/bin/env tsx
// AQU-2211: one-off backfill of `files.kind` for files the Codex migrator
// brought over as `codex`.
//
// The migrator used to stamp every non-IDML file `codex`, whatever it had been
// in Codex. `src/lib/migrate/map.ts` now reads the notebook's own record of its
// importer (`importerType`, falling back to the uploaded file's name — see
// `src/lib/migrate/file-type.ts`). But the `file.create` event id is
// deterministic and ingest ignores events it has already seen, so a delta-sync
// run never retypes a file that is already here. This fills in the files that
// predate the fix, by reading each notebook's metadata from Codex (GitLab)
// again and applying the SAME rule — shared code, so the two cannot drift.
//
// What it touches: `kind = 'codex'` rows only, matched to their notebook by
// the deterministic file id (`fileIdFor(gitlabId, stem)`), never by name.
//   - a notebook that resolves to an Aquilla type: `kind` is set and
//     `meta.legacyCodex` records the raw importerType / originalName
//   - a notebook that does not (no importer, or one Aquilla has no type for):
//     `kind` stays `codex`, `meta.legacyCodex` is still recorded
//   - an IDML notebook, a file with no notebook behind it, and every row of
//     any other kind: left alone
// The `kind = 'codex'` predicate is on the UPDATE too, so a row retyped
// between the read and the write is never overwritten. Safe to re-run.
//
// DRY RUN BY DEFAULT — prints the plan and per-type counts, writes nothing.
// Pass --apply to write. Dev first, production only after the dev counts
// have been reviewed on the ticket.
//
//   pnpm neon:backfill:file-kinds:dev                     # dry run against dev
//   pnpm neon:backfill:file-kinds:dev --only 47,1130      # one or more GitLab project ids
//   pnpm neon:backfill:file-kinds:dev --apply             # write to dev
//   pnpm neon:backfill:file-kinds:prod                    # dry run against prod
//
// Needs GitLab credentials in the env, as the migrator does:
// FRONTIER_USERNAME + FRONTIER_PASSWORD (preferred) or FRONTIER_TOKEN + GITLAB_URL.
// Flags: --apply  --verbose  --only <gitlabId[,gitlabId…]>  --limit <projects>
import { makeMaintenancePostgres } from '../db/shim/postgres'
import { parseCodexNotebook } from '../src/lib/codex-editor/parse-codex'
import type { CodexNotebookFile } from '../src/lib/codex-editor/types'
import {
  getProjectById,
  getRepositoryFileRaw,
  getRepositoryTree,
  listProjects,
  type GitLabProject,
} from '../src/lib/migrate/gitlab/api'
import { resolveCredentialsFromEnv, type GitLabCredentials } from '../src/lib/migrate/gitlab/auth'
import { fileIdFor, projectIdFor } from '../src/lib/migrate/ids'
import {
  decideFileKind,
  tallyDecisions,
  type CodexFileRow,
  type FileKindDecision,
} from './lib/backfill-file-kinds'

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || 'neondb'
  const role = process.env.NEON_PG_ROLE?.trim() || 'neondb_owner'
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error('NEON_PG_HOST and NEON_PG_PASSWORD are required')
  const url = new URL('postgresql://placeholder')
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set('sslmode', 'require')
  return url.toString()
}

interface Flags {
  apply: boolean
  verbose: boolean
  only: number[]
  limit: number
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { apply: false, verbose: false, only: [], limit: Number.POSITIVE_INFINITY }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') flags.apply = true
    else if (arg === '--verbose') flags.verbose = true
    else if (arg === '--only') {
      flags.only = (argv[++i] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
      if (flags.only.length === 0) throw new Error('--only needs one or more numeric GitLab project ids')
    } else if (arg === '--limit') {
      flags.limit = Number(argv[++i])
      if (!Number.isInteger(flags.limit) || flags.limit <= 0) throw new Error('--limit needs a positive integer')
    } else throw new Error(`unknown flag ${arg}`)
  }
  return flags
}

interface KindCount {
  kind: string
  n: number
}

type Db = ReturnType<typeof makeMaintenancePostgres>

async function countsByKind(db: Db): Promise<KindCount[]> {
  const { results } = await db
    .prepare(`SELECT COALESCE(kind, '(null)') AS kind, COUNT(*) AS n FROM files GROUP BY 1 ORDER BY 1`)
    .all<{ kind: string; n: number | string }>()
  return results.map((r) => ({ kind: r.kind, n: Number(r.n) }))
}

function printCounts(label: string, counts: KindCount[]): void {
  console.log(`${label}: files by kind`)
  for (const { kind, n } of counts) console.log(`  ${kind.padEnd(12)} ${n}`)
}

/** Stems of the `.codex` / `.source` blobs in one directory of the repo. */
async function stemsIn(
  creds: GitLabCredentials,
  project: GitLabProject,
  dir: string,
  ext: string,
  ref: string,
): Promise<Set<string>> {
  const entries = await getRepositoryTree(creds, project.id, dir, ref, false)
  return new Set(entries.filter((e) => e.type === 'blob' && e.name.endsWith(ext)).map((e) => e.name.slice(0, -ext.length)))
}

async function readNotebook(
  creds: GitLabCredentials,
  project: GitLabProject,
  filePath: string,
  ref: string,
): Promise<CodexNotebookFile | undefined> {
  const raw = await getRepositoryFileRaw(creds, project.id, filePath, ref)
  if (raw === null) return undefined
  try {
    return parseCodexNotebook(raw)
  } catch {
    return undefined
  }
}

/** Run `fn` over `items` with at most `width` in flight; results in input order. */
async function mapPooled<T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return out
}

interface PlannedRow {
  row: CodexFileRow
  gitlabId: number
  stem: string
  decision: FileKindDecision
}

async function planProject(
  creds: GitLabCredentials,
  project: GitLabProject,
  rows: readonly CodexFileRow[],
  verbose: boolean,
): Promise<PlannedRow[]> {
  const ref = project.default_branch ?? 'main'
  const projectKey = String(project.id)
  const targets = await stemsIn(creds, project, 'files/target', '.codex', ref)
  const sources = await stemsIn(creds, project, '.project/sourceTexts', '.source', ref)
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const stems = [...new Set([...targets, ...sources])].sort()
  const matched = stems
    .map((stem) => ({ stem, row: rowById.get(fileIdFor(projectKey, stem)) }))
    .filter((m): m is { stem: string; row: CodexFileRow } => m.row !== undefined)
  const seen = new Set(matched.map((m) => m.row.id))
  const orphans: PlannedRow[] = rows
    .filter((r) => !seen.has(r.id))
    .map((row) => ({ row, gitlabId: project.id, stem: row.name, decision: { action: 'skip', reason: 'no notebook on GitLab' } }))

  const planned = await mapPooled(matched, 6, async ({ stem, row }): Promise<PlannedRow> => {
    const target = targets.has(stem) ? await readNotebook(creds, project, `files/target/${stem}.codex`, ref) : undefined
    // The rule reads the target first and the source for what it lacks; the
    // source is only fetched when the target does not name its importer, which
    // is exactly when it can change the answer (file-type.ts).
    const source = !target?.metadata.importerType && sources.has(stem)
      ? await readNotebook(creds, project, `.project/sourceTexts/${stem}.source`, ref)
      : undefined
    const decision = decideFileKind(row, { source, target })
    if (verbose) {
      const what = decision.action === 'retype'
        ? `-> ${decision.kind}`
        : decision.action === 'annotate'
          ? `stays codex (${decision.reason})`
          : `untouched (${decision.reason})`
      console.log(`  ${String(project.id).padStart(6)} ${stem.padEnd(48)} ${what}`)
    }
    return { row, gitlabId: project.id, stem, decision }
  })
  return [...planned, ...orphans]
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const db = makeMaintenancePostgres(connectionString(), 1)
  try {
    printCounts('before', await countsByKind(db))

    const { results: candidates } = await db
      .prepare(`SELECT id, project_id, name, meta FROM files WHERE kind = 'codex' ORDER BY project_id, name`)
      .all<CodexFileRow>()
    const byProject = new Map<string, CodexFileRow[]>()
    for (const row of candidates) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row])
    console.log(`${candidates.length} codex files across ${byProject.size} projects`)
    if (candidates.length === 0) return

    const creds = await resolveCredentialsFromEnv()
    // Every migrated project's id is `projectIdFor(gitlabId)`, so the GitLab
    // listing alone says which projects to read — no metadata.json probing.
    const gitlabProjects: GitLabProject[] = flags.only.length > 0
      ? (await Promise.all(flags.only.map((id) => getProjectById(creds, id)))).filter((p): p is GitLabProject => p !== null)
      : await listProjects(creds)
    const onGitlab = gitlabProjects.filter((p) => byProject.has(projectIdFor(String(p.id), 'gitlab')))
    const rowsOf = (p: GitLabProject) => byProject.get(projectIdFor(String(p.id), 'gitlab'))?.length ?? 0
    console.log(
      `${onGitlab.length} of those projects are on GitLab (${onGitlab.reduce((n, p) => n + rowsOf(p), 0)} files); ` +
        `${byProject.size - onGitlab.length} are not (local-source migrations, or not visible to this token) and are left alone`,
    )
    const matched = onGitlab.slice(0, flags.limit)
    if (matched.length < onGitlab.length) {
      console.log(`--limit ${flags.limit}: reading ${matched.length} of them (${matched.reduce((n, p) => n + rowsOf(p), 0)} files)`)
    }

    const plan: PlannedRow[] = []
    for (const project of matched) {
      const rows = byProject.get(projectIdFor(String(project.id), 'gitlab')) ?? []
      console.log(`• ${project.name} [${project.path_with_namespace}] (gitlab ${project.id}): ${rows.length} codex files`)
      plan.push(...(await planProject(creds, project, rows, flags.verbose)))
    }

    console.log('plan:')
    for (const [what, n] of tallyDecisions(plan.map((p) => p.decision))) console.log(`  ${what}: ${n}`)
    const writes = plan.filter((p) => p.decision.action !== 'skip')
    if (!flags.apply) {
      console.log(`dry run: ${writes.length} rows would change, nothing written. Re-run with --apply to write.`)
      return
    }

    let written = 0
    for (const { row, decision } of writes) {
      if (decision.action === 'skip') continue
      // `kind = 'codex'` in the predicate as well as the selector: a row
      // retyped between the read above and this write is never overwritten.
      const res = decision.action === 'retype'
        ? await db
          .prepare(
            `UPDATE files
                SET kind = ?, meta = ?, updated_at = (extract(epoch from now()) * 1000)::bigint
              WHERE id = ? AND project_id = ? AND kind = 'codex'`,
          )
          .bind(decision.kind, decision.meta, row.id, row.project_id)
          .run()
        : await db
          .prepare(
            `UPDATE files
                SET meta = ?, updated_at = (extract(epoch from now()) * 1000)::bigint
              WHERE id = ? AND project_id = ? AND kind = 'codex'`,
          )
          .bind(decision.meta, row.id, row.project_id)
          .run()
      written += res.meta.changes
      if (written % 500 === 0) console.log(`file-kind backfill: ${written}/${writes.length} rows`)
    }
    console.log(`${written} rows written`)
    printCounts('after', await countsByKind(db))
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
