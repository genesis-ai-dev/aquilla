#!/usr/bin/env tsx
/**
 * AQU-1868 — measure the seeded Big Bible project and check it against the
 * budgets in `scripts/perf/budgets.json`.
 *
 *   pnpm dev
 *   pnpm perf:seed
 *   pnpm perf:measure                      # every section, budgets enforced
 *   pnpm perf:measure --only cells.read.full,events.commit
 *   pnpm perf:measure --suggest-budgets    # print a budgets.json from this run
 *
 * Exits non-zero when a budget is breached, and when a budgeted metric was
 * never measured (unless `--allow-unmeasured`): a harness that quietly stops
 * checking half its budgets is worse than no harness. The report is written to
 * `perf-report/` for CI to keep as an artifact.
 *
 * Sections: project.open, files.read, progress.read, cells.read.page,
 * cells.read.full, events.commit, browser, presence.
 */

import { parseArgs } from "node:util"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { v7 as uuidv7 } from "uuid"
import {
  DEFAULT_TARGET,
  devLogin,
  mintSyncToken,
  postEvents,
  readCellsPage,
  readFiles,
  readProgress,
  type PerfTarget,
} from "./lib/client"
import { DEFAULT_HANDLE_PATH, readHandle, type BigBibleHandle } from "./lib/fixture-handle"
import { evaluateBudgets, parseBudgetFile } from "./lib/budgets"
import { flattenSummary, renderReport, type MetricMap, type PerfReport } from "./lib/report"
import { runConcurrently, summarize, timed, type LatencySummary } from "./lib/stats"
import { browserMetrics, probeScreens } from "./lib/browser-probe"
import { presenceMetrics, runPresenceLoad } from "./lib/presence"

const ALL_SECTIONS = [
  "project.open",
  "files.read",
  "progress.read",
  "cells.read.page",
  "cells.read.full",
  "events.commit",
  "browser",
  "presence",
] as const
type Section = (typeof ALL_SECTIONS)[number]

/** `src/lib/sync/outbox-types.ts` OUTBOX_SCHEMA_VERSION. */
const SCHEMA_VERSION = 1
/** The page size `useCells` streams with. */
const CELLS_PAGE_SIZE = 500

interface MeasureOptions {
  handle: string
  target: PerfTarget
  appBase: string | null
  editorReady: string
  rulesReady: string
  sections: Set<Section>
  iterations: number
  writers: number
  commits: number
  sockets: number
  presenceSeconds: number
  budgetsPath: string
  outDir: string
  allowUnmeasured: boolean
  suggestBudgets: boolean
  screenTimeoutMs: number
}

function parseMeasureOptions(argv: string[]): MeasureOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      handle: { type: "string" },
      only: { type: "string" },
      skip: { type: "string" },
      iterations: { type: "string" },
      writers: { type: "string" },
      commits: { type: "string" },
      sockets: { type: "string" },
      duration: { type: "string" },
      budgets: { type: "string" },
      out: { type: "string" },
      "app-base": { type: "string" },
      "editor-ready": { type: "string" },
      "rules-ready": { type: "string" },
      "screen-timeout": { type: "string" },
      "auth-base": { type: "string" },
      "sync-base": { type: "string" },
      "allow-unmeasured": { type: "boolean" },
      "suggest-budgets": { type: "boolean" },
      "no-browser": { type: "boolean" },
    },
    allowPositionals: false,
  })
  const num = (raw: string | undefined, fallback: number): number =>
    raw === undefined ? fallback : Number(raw)

  const named = (raw: string | undefined): Section[] => {
    if (!raw) return []
    return raw.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      if (!(ALL_SECTIONS as readonly string[]).includes(part)) {
        throw new Error(`unknown section "${part}" — known: ${ALL_SECTIONS.join(", ")}`)
      }
      return part as Section
    })
  }
  const only = named(values.only)
  const skip = new Set(named(values.skip))
  if (values["no-browser"]) skip.add("browser")
  const sections = new Set<Section>(only.length > 0 ? only : ALL_SECTIONS)
  for (const section of skip) sections.delete(section)

  return {
    handle: values.handle ?? DEFAULT_HANDLE_PATH,
    target: {
      authBase: values["auth-base"] ?? DEFAULT_TARGET.authBase,
      syncBase: values["sync-base"] ?? DEFAULT_TARGET.syncBase,
    },
    appBase: values["app-base"] ?? "http://127.0.0.1:5173",
    editorReady: values["editor-ready"] ?? "[data-cell-id]",
    rulesReady: values["rules-ready"] ?? "main",
    sections,
    iterations: Math.max(1, Math.floor(num(values.iterations, 10))),
    writers: Math.max(1, Math.floor(num(values.writers, 8))),
    commits: Math.max(1, Math.floor(num(values.commits, 40))),
    sockets: Math.max(1, Math.floor(num(values.sockets, 50))),
    presenceSeconds: Math.max(1, num(values.duration, 20)),
    budgetsPath: values.budgets ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "budgets.json"),
    outDir: values.out ?? "perf-report",
    allowUnmeasured: values["allow-unmeasured"] === true,
    suggestBudgets: values["suggest-budgets"] === true,
    screenTimeoutMs: Math.max(5_000, num(values["screen-timeout"], 60_000)),
  }
}

function gitSha(): string | null {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" })
  const sha = result.stdout?.trim()
  return sha ? sha : null
}

/** Read every page of a file's cells, as the editor's initial stream does. */
async function readWholeFile(
  target: PerfTarget,
  token: string,
  projectId: string,
  fileId: string,
): Promise<number> {
  let cursor: string | null = null
  let rows = 0
  for (;;) {
    const page = await readCellsPage(target, token, projectId, fileId, {
      limit: CELLS_PAGE_SIZE,
      cursor,
    })
    rows += page.cells?.length ?? 0
    cursor = page.nextCursor ?? null
    if (!cursor) return rows
  }
}

/** Repeat one timed operation `iterations` times. */
async function repeat(iterations: number, op: () => Promise<unknown>): Promise<LatencySummary> {
  const samples: number[] = []
  for (let index = 0; index < iterations; index++) {
    const { ms } = await timed(op)
    samples.push(ms)
  }
  return summarize(samples)
}

interface CommitAnchor {
  fileId: string
  cellId: string
  parentEventId: string
  token: string
}

/**
 * One anchor per distinct cell: concurrent commits must not contend for the
 * same chain head, or the measurement is of the stale-sibling path rather than
 * of a commit.
 */
async function buildCommitAnchors(
  target: PerfTarget,
  jwt: string,
  handle: BigBibleHandle,
  wanted: number,
): Promise<CommitAnchor[]> {
  const anchors: CommitAnchor[] = []
  for (const file of handle.files) {
    if (anchors.length >= wanted) break
    if (file.commitTargets.length === 0) continue
    const token = await mintSyncToken(target, jwt, handle.projectId, file.id)
    for (const anchor of file.commitTargets) {
      if (anchors.length >= wanted) break
      anchors.push({ fileId: file.id, cellId: anchor.cellId, parentEventId: anchor.parentEventId, token })
    }
  }
  return anchors
}

async function main(): Promise<void> {
  const options = parseMeasureOptions(process.argv.slice(2))
  const handle = readHandle(options.handle)
  const target: PerfTarget = {
    authBase: options.target.authBase || handle.target.authBase,
    syncBase: options.target.syncBase || handle.target.syncBase,
  }
  const budgets = parseBudgetFile(JSON.parse(readFileSync(options.budgetsPath, "utf8")))
  const session = await devLogin(target)

  // The biggest file is the interesting one: whatever is file-proportional
  // shows up there first (PSA, ~2.5k cells in the default fixture).
  const measuredFile = [...handle.files].sort((a, b) => b.cells - a.cells)[0]
  if (!measuredFile) throw new Error("fixture handle lists no files")
  const token = await mintSyncToken(target, session.jwt, handle.projectId, measuredFile.id)

  console.log(
    `[perf] measuring project ${handle.projectId} (${handle.stats.files} files, `
      + `${handle.stats.cells.toLocaleString()} cells) — file ${measuredFile.name} `
      + `(${measuredFile.cells.toLocaleString()} cells)`,
  )

  const startedAtMs = Date.now()
  const operations: Record<string, LatencySummary> = {}
  const metrics: MetricMap = {}
  const skipped: Record<string, string> = {}
  const record = (name: string, summary: LatencySummary): void => {
    operations[name] = summary
    Object.assign(metrics, flattenSummary(name, summary))
  }

  if (options.sections.has("files.read")) {
    console.log("[perf] files.read …")
    record("files.read", await repeat(options.iterations, () =>
      readFiles(target, token, handle.projectId)))
  }

  if (options.sections.has("progress.read")) {
    console.log("[perf] progress.read …")
    record("progress.read", await repeat(options.iterations, () =>
      readProgress(target, token, handle.projectId, measuredFile.id)))
  }

  if (options.sections.has("cells.read.page")) {
    console.log("[perf] cells.read.page …")
    record("cells.read.page", await repeat(options.iterations, () =>
      readCellsPage(target, token, handle.projectId, measuredFile.id, { limit: CELLS_PAGE_SIZE })))
  }

  if (options.sections.has("cells.read.full")) {
    console.log(`[perf] cells.read.full (${measuredFile.cells.toLocaleString()} cells, pages of ${CELLS_PAGE_SIZE}) …`)
    let lastRows = 0
    record("cells.read.full", await repeat(options.iterations, async () => {
      lastRows = await readWholeFile(target, token, handle.projectId, measuredFile.id)
    }))
    metrics["cells.read.full.rows"] = lastRows
  }

  if (options.sections.has("project.open")) {
    console.log("[perf] project.open (files + progress + first page, as the SPA opens) …")
    record("project.open", await repeat(options.iterations, async () => {
      await readFiles(target, token, handle.projectId)
      await readProgress(target, token, handle.projectId, measuredFile.id)
      await readCellsPage(target, token, handle.projectId, measuredFile.id, { limit: CELLS_PAGE_SIZE })
    }))
  }

  if (options.sections.has("events.commit")) {
    const anchors = await buildCommitAnchors(target, session.jwt, handle, options.commits)
    if (anchors.length === 0) {
      skipped["events.commit"] = "the fixture handle recorded no commit anchors — re-seed with target lanes"
    } else {
      if (anchors.length < options.commits) {
        console.log(
          `[perf] events.commit: only ${anchors.length} distinct anchors in the fixture; `
            + `measuring ${anchors.length} commits instead of ${options.commits}`,
        )
      }
      console.log(`[perf] events.commit (${anchors.length} commits, ${options.writers} concurrent writers) …`)
      const { samples, elapsedMs, errors } = await runConcurrently(
        anchors.length,
        options.writers,
        async (index) => {
          const anchor = anchors[index]
          await postEvents(target, anchor.token, [
            {
              id: uuidv7(),
              schemaVersion: SCHEMA_VERSION,
              kind: "target.cell.commit",
              projectId: handle.projectId,
              fileId: anchor.fileId,
              cellId: anchor.cellId,
              parentId: anchor.parentEventId,
              author: session.username,
              payload: { value: `Perf measurement ${startedAtMs} on ${anchor.cellId}` },
              clientTs: Date.now(),
            },
          ])
        },
      )
      if (errors.length > 0) {
        // A failed write is not a fast write — say so instead of reporting the
        // p95 of whatever survived.
        throw new Error(
          `events.commit: ${errors.length} of ${anchors.length} commits failed (first: ${errors[0]})`,
        )
      }
      record("events.commit", summarize(samples, elapsedMs))
    }
  }

  if (options.sections.has("browser")) {
    if (!options.appBase) {
      skipped.browser = "no --app-base"
    } else {
      console.log(`[perf] browser screens against ${options.appBase} …`)
      const probes = await probeScreens({
        appBase: options.appBase,
        projectId: handle.projectId,
        fileId: measuredFile.id,
        editorReadySelector: options.editorReady,
        rulesReadySelector: options.rulesReady,
        timeoutMs: options.screenTimeoutMs,
        settleMs: 3_000,
        log: (line) => console.log(line),
      })
      Object.assign(metrics, browserMetrics(probes))
    }
  }

  if (options.sections.has("presence")) {
    console.log(`[perf] presence (${options.sockets} sockets, ${options.presenceSeconds}s) …`)
    const result = await runPresenceLoad({
      target,
      jwt: session.jwt,
      projectId: handle.projectId,
      fileId: measuredFile.id,
      username: session.username,
      sockets: options.sockets,
      durationMs: options.presenceSeconds * 1_000,
      pingIntervalMs: 2_000,
      updateIntervalMs: 3_000,
      staggerMs: 20,
      cellIds: measuredFile.commitTargets.map((anchor) => anchor.cellId),
      log: (line) => console.log(line),
    })
    record("presence.ping", result.ping)
    Object.assign(metrics, presenceMetrics(result))
  }

  for (const section of ALL_SECTIONS) {
    if (!options.sections.has(section) && !(section in skipped)) {
      skipped[section] = "not selected for this run"
    }
  }

  const evaluation = evaluateBudgets(metrics, budgets)
  const blockingUnmeasured = options.allowUnmeasured ? [] : evaluation.unmeasured
  const report: PerfReport = {
    harness: "big-bible",
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Date.now() - startedAtMs,
    gitSha: gitSha(),
    target: { ...target, appBase: options.sections.has("browser") ? options.appBase : null },
    fixture: {
      projectId: handle.projectId,
      files: handle.stats.files,
      cells: handle.stats.cells,
      measuredFileId: measuredFile.id,
      measuredFileName: measuredFile.name,
      measuredFileCells: measuredFile.cells,
    },
    operations,
    metrics,
    skipped,
    budgets: evaluation,
    passed: evaluation.breaches.length === 0 && blockingUnmeasured.length === 0,
  }

  mkdirSync(path.resolve(options.outDir), { recursive: true })
  const stamp = report.startedAt.replace(/[:.]/g, "-")
  const reportPath = path.join(options.outDir, `big-bible-${stamp}.json`)
  const json = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.resolve(reportPath), json, "utf8")
  writeFileSync(path.resolve(path.join(options.outDir, "latest.json")), json, "utf8")

  console.log("")
  console.log(renderReport(report))
  console.log("")
  console.log(`[perf] report written to ${reportPath}`)

  if (options.suggestBudgets) {
    const suggested = {
      max: Object.fromEntries(
        Object.keys(budgets.max)
          .filter((metric) => metrics[metric] !== undefined)
          .map((metric) => [metric, Math.ceil((metrics[metric] * 1.3) / 10) * 10]),
      ),
      min: Object.fromEntries(
        Object.keys(budgets.min)
          .filter((metric) => metrics[metric] !== undefined)
          .map((metric) => [metric, Math.floor(metrics[metric] * 0.7)]),
      ),
    }
    console.log("")
    console.log("[perf] suggested budgets (this run +30% headroom on maxima, -30% on minima):")
    console.log(JSON.stringify(suggested, null, 2))
  }

  if (!report.passed) {
    if (evaluation.breaches.length > 0) {
      console.error(`[perf] FAIL — ${evaluation.breaches.length} budget breach(es)`)
    }
    if (blockingUnmeasured.length > 0) {
      console.error(
        `[perf] FAIL — budgeted metrics not measured: ${blockingUnmeasured.join(", ")} `
          + "(pass --allow-unmeasured for a deliberately partial run)",
      )
    }
    process.exit(1)
  }
  console.log("[perf] PASS — every budget met")
}

main().catch((error: unknown) => {
  console.error(`[perf] measure failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
