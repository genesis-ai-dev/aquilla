// AQU-2115 — the decisions behind `scripts/neon-copy-dev-audio-all.ts`: which
// projects the nightly dev refresh owes audio to, what order to fill them in,
// when to stop for the night, and what the run page gets to say about it. Kept
// apart from the script so each one is unit-testable without an R2 account or a
// database, exactly as AQU-2114 split `dev-audio-copy.ts` from its CLI.
//
// WHY THIS EXISTS ON TOP OF AQU-2114: that slice copies ONE project on demand,
// which is what you want when you are debugging one project. The nightly
// "Refresh Dev Neon Branch" workflow restores every project's audio ROWS and
// none of their BYTES, so every project with audio 404s on dev until somebody
// remembers to run the one-project copy for it. This runs AQU-2114's copy
// across all of them, as its own workflow step after the restore.
//
// THE THREE CONSTRAINTS THAT SHAPE IT:
//  1. The first backfill is ~561k objects / 167 GB. It cannot finish in one
//     run, so the run takes a TIME BUDGET and stops at a project boundary;
//     objects already in dev are skipped, so the next run resumes where this
//     one stopped without any persisted cursor.
//  2. Because a run is a slice of the backfill, ORDER decides who gets audio
//     first. Most recently active project first — those are the ones someone is
//     about to test on dev.
//  3. One project's failure is not the run's. A failed project is counted and
//     reported; the rest still copy. The step turns red at the end so the
//     failure is visible, but the restore that ran BEFORE it stays green.

import type { AquillaDb } from "../db/shim/postgres"
import type { DevAudioCopyReport } from "./dev-audio-copy"

/** Projects copied at once. R2 CopyObject is server-side, so the limit is
 *  Cloudflare's appetite for parallel requests, not this machine's. */
export const DEFAULT_COPY_CONCURRENCY = 4
/** Per-run wall-clock budget. The nightly refresh step is budgeted well inside
 *  the job's own timeout so the step reports rather than being killed. */
export const DEFAULT_BUDGET_MINUTES = 240
/** Example project ids carried in the report, so a dry run is reviewable. */
export const MAX_SAMPLE_PROJECTS = 10

/** A project the restored dev rows say has audio, with the recency that orders it. */
export interface AudioProject {
  projectId: string
  name: string | null
  /** ms since the epoch of the most recent audio activity we can see, 0 when
   *  nothing dates it. Ordering only — never used as a cursor. */
  lastActivityMs: number
}

/**
 * Every project the restored dev database says references media, newest audio
 * activity first.
 *
 * The four sources are the four `db/shared/media-refs.ts` reference queries
 * read per project, lifted to "which projects would those return anything for":
 * live takes, agent-API audio artifacts, queued/running diarization jobs, and
 * voices/ clips the settings blob points at: a voice's Inworld voice-design
 * preview (`designPreviewAudioId`), and a trained custom voice (`customVoice`),
 * whose training recordings live under voices/ and are listed by its consent
 * record rather than by any row. A project missed here is a project that stays
 * silent on dev, so the union is deliberately wider than "has a take" — a
 * project whose only media is a voice's clips still needs its bytes. (The
 * short-clip clone `referenceAudioId` is no longer a reason on its own: those
 * voices were removed in AQU-2291 and now play as plain TTS voices.)
 *
 * Recency comes from `cell_audio.created_ts` (ms, the take's own clock) and
 * falls back to the project's `updated_at`, so a project whose only media is a
 * voice clip still sorts somewhere sensible instead of last.
 */
export async function loadAudioProjects(db: AquillaDb): Promise<AudioProject[]> {
  const rows = await db
    .prepare(
      `WITH media_projects AS (
         SELECT project_id, MAX(created_ts) AS last_audio_ms
           FROM cell_audio
          WHERE deleted = 0
          GROUP BY project_id
         UNION
         SELECT project_id, NULL::bigint
           FROM artifacts
          WHERE kind = 'audio' AND audio_id IS NOT NULL
         UNION
         SELECT project_id, NULL::bigint
           FROM diarization_jobs
          WHERE status IN ('queued', 'running')
         UNION
         SELECT ps.project_id, NULL::bigint
           FROM project_settings ps,
                jsonb_array_elements(
                  CASE WHEN jsonb_typeof(ps.settings::jsonb -> 'ttsSettings' -> 'voices') = 'array'
                       THEN ps.settings::jsonb -> 'ttsSettings' -> 'voices'
                       ELSE '[]'::jsonb END
                ) AS v
          WHERE v->>'designPreviewAudioId' IS NOT NULL
             OR jsonb_typeof(v -> 'customVoice') = 'object'
       )
       SELECT m.project_id,
              p.name,
              COALESCE(
                MAX(m.last_audio_ms),
                (EXTRACT(EPOCH FROM MAX(p.updated_at)) * 1000)::bigint,
                0
              ) AS last_activity_ms
         FROM media_projects m
         JOIN projects p ON p.id = m.project_id
        GROUP BY m.project_id, p.name`,
    )
    .all<{ project_id: string; name: string | null; last_activity_ms: number | string | null }>()

  return orderProjects(
    (rows.results ?? []).map((row) => ({
      projectId: row.project_id,
      name: row.name,
      lastActivityMs: Number(row.last_activity_ms ?? 0) || 0,
    })),
  )
}

/**
 * Most recently active first, ties broken by project id.
 *
 * The tie-break is not cosmetic: with a time budget, two runs that disagree
 * about the order of equally-stale projects would each copy a different prefix
 * of them and the backfill would crawl. A total order makes a budget-limited
 * run resume where the last one stopped.
 */
export function orderProjects(projects: readonly AudioProject[]): AudioProject[] {
  return [...projects].sort(
    (a, b) => b.lastActivityMs - a.lastActivityMs || a.projectId.localeCompare(b.projectId),
  )
}

/**
 * A positive-number flag, or the default.
 *
 * A typo'd value is an ERROR rather than a silent fall-back: a run that quietly
 * used the 4-hour default when the operator asked for `--budget-minutes 20`
 * holds the workflow open for four hours and looks like it worked.
 */
export function numberFlag(argv: readonly string[], name: string, fallback: number): number {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const raw = argv[i + 1]
  const value = Number(raw)
  if (!raw || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} needs a positive number, got '${raw ?? ""}'`)
  }
  return value
}

export interface CopyAllDeps {
  /** The projects the restored dev rows say reference media, in copy order. */
  listProjects(): Promise<AudioProject[]>
  /** AQU-2114's one-project copy. Its guards are the only ones that matter:
   *  nothing here can widen the source, destination or database it accepts. */
  copyOne(projectId: string): Promise<DevAudioCopyReport>
  /** Injected so the budget is testable without sleeping. */
  now(): number
}

export interface CopyAllOptions {
  dryRun?: boolean
  concurrency?: number
  budgetMs?: number
  /** Cap the projects considered at all — a dispatch escape hatch for trying
   *  the step out without committing to a full pass. */
  limit?: number
}

export interface ProjectFailure {
  projectId: string
  error: string
}

export interface CopyAllReport {
  dryRun: boolean
  /** Projects the database says reference media (after `limit`). */
  projectsTotal: number
  /** Projects this run copied, or would have copied on a dry run. */
  projectsDone: number
  /** Projects the budget left for the next run. */
  projectsRemaining: number
  projectsFailed: ProjectFailure[]
  referenced: number
  referencedBytes: number
  alreadyInDev: number
  copied: number
  copiedBytes: number
  /** Referenced rows whose object is absent from prod too, summed. Reported,
   *  never an error: the row outlived its bytes. */
  missingInProd: number
  /** Individual keys whose copy threw, summed across projects. */
  failedObjects: number
  durationMs: number
  /** True when the run stopped on the clock rather than on the work. */
  budgetExhausted: boolean
  /** Up to MAX_SAMPLE_PROJECTS ids this run copied something into. */
  samples: string[]
}

/**
 * Run AQU-2114's per-project copy across every project with media, newest
 * first, bounded by `concurrency` and `budgetMs`.
 *
 * The budget is checked when a worker PICKS UP a project, never mid-project: a
 * half-copied project is fine (the next run finishes it, because dev already
 * holds what this run copied) but a project abandoned mid-listing would report
 * counts that describe nothing. So an over-budget run finishes its in-flight
 * projects and declines to start more.
 */
export async function copyAllProjectAudio(
  deps: CopyAllDeps,
  options: CopyAllOptions = {},
): Promise<CopyAllReport> {
  const dryRun = options.dryRun ?? false
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_COPY_CONCURRENCY))
  const budgetMs = Math.max(0, options.budgetMs ?? DEFAULT_BUDGET_MINUTES * 60_000)
  const started = deps.now()

  const all = await deps.listProjects()
  const projects = options.limit === undefined ? all : all.slice(0, Math.max(0, options.limit))

  const report: CopyAllReport = {
    dryRun,
    projectsTotal: projects.length,
    projectsDone: 0,
    projectsRemaining: projects.length,
    projectsFailed: [],
    referenced: 0,
    referencedBytes: 0,
    alreadyInDev: 0,
    copied: 0,
    copiedBytes: 0,
    missingInProd: 0,
    failedObjects: 0,
    durationMs: 0,
    budgetExhausted: false,
    samples: [],
  }

  let next = 0
  const takeProject = (): AudioProject | null => {
    if (next >= projects.length) return null
    if (deps.now() - started >= budgetMs) {
      report.budgetExhausted = true
      return null
    }
    return projects[next++]!
  }

  const worker = async (): Promise<void> => {
    for (let project = takeProject(); project; project = takeProject()) {
      try {
        const one = await deps.copyOne(project.projectId)
        report.referenced += one.referenced
        report.referencedBytes += one.referencedBytes
        report.alreadyInDev += one.alreadyInDev
        report.copied += one.copied
        report.copiedBytes += one.copiedBytes
        report.missingInProd += one.missingInProd.length
        report.failedObjects += one.failed.length
        // A dry run reports what it WOULD copy, so sample on the gap rather
        // than on `copied`, which a dry run never increments.
        const moved = dryRun ? one.referenced - one.alreadyInDev : one.copied
        if (moved > 0 && report.samples.length < MAX_SAMPLE_PROJECTS) {
          report.samples.push(project.projectId)
        }
      } catch (error) {
        // One project's bad row or unreadable prefix does not cost the other
        // 400 theirs. The step still ends non-zero, so the failure is visible.
        report.projectsFailed.push({
          projectId: project.projectId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      report.projectsDone++
      report.projectsRemaining = projects.length - report.projectsDone
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker))

  report.durationMs = deps.now() - started
  return report
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
}

/**
 * The run-page summary. Markdown, because this is written to
 * `$GITHUB_STEP_SUMMARY` — the acceptance criterion is that every scheduled run
 * SHOWS these counts, not that they are somewhere in a step log nobody opens
 * (the AQU-1344 lesson, applied before it can happen here).
 */
export function formatCopyAllReport(report: CopyAllReport): string {
  const headline = report.projectsFailed.length
    ? `⚠️ ${report.projectsFailed.length} project(s) failed`
    : report.budgetExhausted
      ? "⏳ time budget reached — the next run resumes"
      : "✅ every project with media is in dev"
  const lines = [
    `## Copy prod audio to dev — ${headline}`,
    "",
    `| metric | value |`,
    `|---|---|`,
    `| projects with media | ${report.projectsTotal} |`,
    `| projects done this run | ${report.projectsDone} |`,
    `| projects remaining | ${report.projectsRemaining} |`,
    `| referenced objects | ${report.referenced} (${mb(report.referencedBytes)}) |`,
    `| already in dev | ${report.alreadyInDev} |`,
    report.dryRun
      ? `| would copy | ${report.referenced - report.alreadyInDev} |`
      : `| copied | ${report.copied} (${mb(report.copiedBytes)}) |`,
    `| missing in prod | ${report.missingInProd} |`,
    `| failed objects | ${report.failedObjects} |`,
    `| failed projects | ${report.projectsFailed.length} |`,
    `| duration | ${duration(report.durationMs)} |`,
    `| time budget reached | ${report.budgetExhausted ? "yes" : "no"} |`,
  ]
  if (report.dryRun) lines.push("", "_dry run — nothing was written._")
  if (report.projectsFailed.length) {
    lines.push("", "### Failed projects", "")
    for (const failure of report.projectsFailed.slice(0, MAX_SAMPLE_PROJECTS)) {
      lines.push(`- \`${failure.projectId}\`: ${failure.error}`)
    }
  }
  if (report.samples.length) {
    lines.push(
      "",
      `### Sample project(s)${report.dryRun ? " that would be copied" : " copied into"}`,
      "",
    )
    for (const projectId of report.samples) lines.push(`- \`${projectId}\``)
  }
  return lines.join("\n")
}
