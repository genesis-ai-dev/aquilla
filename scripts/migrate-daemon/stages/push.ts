// Stage 4: the daemon's single writer. One project at a time, one chunk at a
// time, paced by the Pacer so prod's Hyperdrive never sees a convoy.
//
// Durability contract: the local ledger is written *after* prod acks a chunk
// ("write-after-ack"). A crash or a failing chunk therefore leaves the ledger a
// strict prefix of what prod holds — never a superset — so the retry re-plans
// only the remainder and no event is silently skipped. The counter-check is the
// verify step: prod's own event count must equal the ledger's, or we throw the
// local mirror away and reseed it from prod.
import type { DaemonDb, JobRow, ProjectRow } from "../db"
import type { SyncClient } from "../http"
import type { Pacer } from "../pacer"
import { readPlan, type PlanLine } from "../plan"
import { CONTENT_LOGIC_VERSION, type MaterializeResult } from "./materialize"
import { copyGitlabIdmlOriginal } from "../../lib/idml-migration-artifacts"
import { buildCastAdditions, castLikeSpeakers } from "../../../src/lib/import/cast-from-speakers"
import type { ProjectTtsSettings } from "../../../src/lib/parsers/types"

/** Plan read granularity. Chunks are assembled from these, so this only needs
 *  to be small enough that the pacer's smallest chunk is still reachable. */
const READ_BATCH = 50

export interface PushDeps {
  db: DaemonDb
  sync: SyncClient
  pacer: Pacer
  dryRun: boolean
  syncBase: string
  syncSecret: string
  log: (msg: string) => void
}
export interface PushInput {
  job: JobRow
  project: ProjectRow
  plan: MaterializeResult
}
export interface PushResult {
  pushed: number
  finalized: boolean
  settingsUpdated: boolean
  verified: boolean
  reseeded: boolean
}

/** Running state threaded through the push passes. `touchedFileIds` collects
 *  the files whose events prod has *acked* — it scopes the finalize (AQU-557),
 *  so a chunk that threw must not contribute to it. */
interface PushState {
  chunkNo: number
  pushed: number
  touchedFileIds: Set<string>
}

/** Throw away the local ledger and rebuild it from prod's own event ids.
 *  `onPage` runs before each page fetch — the weekly reseed uses it to pace
 *  per page rather than per project, so one 17M-id project cannot burst. */
export async function seedLedger(
  db: DaemonDb,
  sync: SyncClient,
  project: ProjectRow,
  opts: { onPage?: () => Promise<void> } = {},
): Promise<number> {
  const ids: string[] = []
  for await (const page of sync.eventIds(project.aquilla_id, opts.onPage)) ids.push(...page)
  db.ledgerReplace(project.gitlab_id, ids)
  return ids.length
}

export async function pushJob(deps: PushDeps, input: PushInput): Promise<PushResult> {
  const { db, sync, dryRun, log } = deps
  const { job, project, plan } = input

  if (dryRun) return dryRunResult(deps, input)

  if (!project.project_upserted) {
    await sync.upsertProject({
      projectId: project.aquilla_id,
      name: project.name,
      orgId: project.org_id!,
      ownerUserId: project.owner_user_id!,
      teamId: project.team_id,
    })
    db.setProjectFields(project.gitlab_id, { project_upserted: 1 })
  }

  const state: PushState = { chunkNo: 0, pushed: 0, touchedFileIds: new Set() }
  // Prerequisites (IDML `file.create`) must land before the source artifact
  // copy references their fileId, and the copies before the rest of the events.
  await pushPass(deps, input, state, (l) => l.prerequisite === true)
  for (const { relPath, fileId, original } of plan.idml) {
    if (!original) {
      log(`  idml original missing for ${relPath} — skipping source-artifact copy`)
      continue
    }
    await copyGitlabIdmlOriginal({
      syncBase: deps.syncBase, secret: deps.syncSecret,
      projectId: project.aquilla_id, fileId, original,
    })
  }
  await pushPass(deps, input, state, (l) => l.prerequisite !== true)

  let finalized = false
  if (state.pushed > 0) {
    // AQU-557: finalize only the files this push landed events for. A push
    // that touched one book used to recompute every file in the project.
    await sync.finalize(project.aquilla_id, [...state.touchedFileIds])
    finalized = true
  }

  const settingsUpdated = await applyCast(deps, project, plan)

  // `eventCount` counts every event prod holds, including human-authored ones
  // that never came from a migration. So only a *deficit* is drift: prod
  // missing events the ledger claims are applied means the mirror is wrong.
  // A surplus is expected in any project people have actually worked in.
  const remote = await sync.eventCount(project.aquilla_id)
  const local = db.ledgerCount(project.gitlab_id)
  if (remote < local) {
    log(`  verify mismatch: prod has ${remote} events, ledger has ${local} — reseeding ledger`)
    await seedLedger(db, sync, project)
    return { pushed: state.pushed, finalized, settingsUpdated, verified: false, reseeded: true }
  }
  if (remote > local) log(`  verify ok: prod has ${remote - local} non-migrate events (human-authored)`)

  db.setFileHashes(project.gitlab_id, plan.fileHashes)
  db.setProjectFields(project.gitlab_id, { applied_sha: job.sha, content_logic: CONTENT_LOGIC_VERSION })
  db.advance(job.id, "done")
  return { pushed: state.pushed, finalized, settingsUpdated, verified: true, reseeded: false }
}

/** One streaming pass over the plan, ingesting the lines `keep` selects.
 *  Chunk size is re-read from the pacer between chunks so backpressure and
 *  recovery take effect mid-project. */
async function pushPass(
  deps: PushDeps,
  input: PushInput,
  state: PushState,
  keep: (l: PlanLine) => boolean,
): Promise<void> {
  let buf: PlanLine[] = []
  for await (const batch of readPlan(input.plan.planPath, READ_BATCH)) {
    for (const line of batch) {
      if (!keep(line)) continue
      buf.push(line)
      if (buf.length >= deps.pacer.chunkSize) {
        await sendChunk(deps, input, state, buf)
        buf = []
      }
    }
  }
  if (buf.length) await sendChunk(deps, input, state, buf)
}

async function sendChunk(
  deps: PushDeps,
  input: PushInput,
  state: PushState,
  chunk: PlanLine[],
): Promise<void> {
  const { db, sync, pacer } = deps
  const chunkNo = ++state.chunkNo
  await pacer.acquire(chunk.length)
  const t0 = Date.now()
  let r: { status: number; ms: number; accepted: number }
  try {
    r = await sync.ingest(input.project.aquilla_id, chunk.map((l) => l.event))
  } catch (e) {
    // The pacer learns from the failure (halve, pause, maybe trip the breaker);
    // the job fails with backoff and the ledger keeps every acked chunk.
    pacer.record({ ok: false, ms: Date.now() - t0 })
    throw e
  }
  pacer.record({ ok: true, ms: r.ms })
  db.ledgerAppend(input.project.gitlab_id, chunk.map((l) => l.id), {
    jobId: input.job.id, chunkNo, ms: r.ms, httpStatus: r.status, attempt: 1,
  })
  state.pushed += chunk.length
  // Recorded only past the ack, alongside the ledger, so a thrown chunk leaves
  // the finalize scope a strict prefix of what prod holds (same contract as
  // the ledger's write-after-ack).
  for (const line of chunk) {
    const fileId = line.event.fileId
    if (typeof fileId === "string" && fileId !== "") state.touchedFileIds.add(fileId)
  }
}

/** Mirrors `applyCast` in scripts/migrate-all.ts — same speaker filter, same
 *  merge shape — but gated on the plan's cast hash so an unchanged cast costs
 *  no round trips. Unlike migrate-all we do not swallow errors: the job fails
 *  and retries rather than leaving a project silently voice-less. */
async function applyCast(deps: PushDeps, project: ProjectRow, plan: MaterializeResult): Promise<boolean> {
  if (plan.speakers.length === 0 || plan.castHash === project.cast_hash) return false
  const speakers = castLikeSpeakers(plan.speakers)
  if (speakers.length === 0) return false
  const settings = (await deps.sync.getSettings(project.aquilla_id)) as { ttsSettings?: ProjectTtsSettings }
  const tts = settings.ttsSettings
  const add = buildCastAdditions(speakers, tts, () => globalThis.crypto.randomUUID())
  const merged: ProjectTtsSettings = {
    ...(tts ?? {}),
    voices: add.voices,
    castAssignments: { ...(tts?.castAssignments ?? {}), ...add.castAssignments },
  }
  await deps.sync.postSettings(project.aquilla_id, { ...settings, ttsSettings: merged })
  deps.db.setProjectFields(project.gitlab_id, { cast_hash: plan.castHash })
  return true
}

async function dryRunResult(deps: PushDeps, input: PushInput): Promise<PushResult> {
  const { plan, project } = input
  let pushed = 0
  for await (const batch of readPlan(plan.planPath, READ_BATCH)) pushed += batch.length
  const chunks = Math.ceil(pushed / Math.max(1, deps.pacer.chunkSize))
  const settings = plan.speakers.length > 0 && plan.castHash !== project.cast_hash
  deps.log(
    `  [dry-run] would push ${pushed} events in ~${chunks} chunks, ` +
    `finalize: ${pushed > 0 ? "yes" : "no"}, settings: ${settings ? "yes" : "no"}`,
  )
  return { pushed, finalized: false, settingsUpdated: false, verified: true, reseeded: false }
}
