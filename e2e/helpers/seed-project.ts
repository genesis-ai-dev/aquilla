/**
 * Server-side project + file seeding for E2E specs.
 *
 * Most specs don't test project creation or file import — they need "a project
 * with sample.md's cells in the editor" as a *precondition*. Driving that
 * through the UI (create-project dialog → import dialog → upload → confirm →
 * settle poll) costs ~10-20s per test. This helper produces the identical
 * server state in ~4 HTTP calls (<1s):
 *
 *   1. POST /api/v2/projects            — register the project (auth-worker)
 *   2. POST /api/v2/sync-token          — mint a (project, file)-scoped token
 *   3. POST /import                     — bulk file.create + source.cell.create
 *   4. POST /import {complete: true}    — finalize counters/progress
 *
 * Cells are produced by the SAME parser the UI import uses
 * (extractMarkdownStrings), so seeded content is byte-identical to what
 * Workspace.importFile(sample.md) would create — specs asserting on cell text
 * keep passing. This is a deliberate exception to the "helpers don't import
 * src/" rule in frontier-api.ts: duplicating the parser here would let seeded
 * state drift from real-import state, which is worse than the coupling.
 *
 * Dedicated coverage for the real UI journeys stays in
 * projects/create.smoke.spec.ts and editor/import-and-edit.smoke.spec.ts —
 * never migrate those two to this helper.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"
import { extractMarkdownStrings } from "../../src/lib/parsers/markdown"
import { extractUsfmStrings } from "../../src/lib/parsers/usfm"
import { aquillaImportMetadata, normalizeTranslatableStrings } from "../../src/lib/import/normalized-manifest"
import { readPersistedSession } from "./auth-state"
import { createProjectServerSide, updateProjectSettings } from "./frontier-api"
import { postIdempotentJson } from "./idempotent-request"
import { Workspace } from "./page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const SYNC_BASE = `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

const DEFAULT_FIXTURE = path.resolve(__dirname, "../fixtures/sample.md")

/** Read the JWT ensureAuthState persisted for this stack and user (the
 * multi-user fixtures mint it before any test body runs). */
export async function jwtFor(username: "alice" | "bob" | "carol"): Promise<string> {
  return (await readPersistedSession(username)).jwt
}

export interface SeededProject {
  projectId: string
  projectName: string
  fileId: string
  fileName: string
  /** cellIds in document order — index-aligned with editor rows. */
  cellIds: string[]
}

export async function mintSyncToken(jwt: string, projectId: string, fileId: string): Promise<string> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ projectId, fileId }),
  })
  if (!r.ok) throw new Error(`sync-token failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { token: string }).token
}

export interface SeededFileEvent {
  id: string
  kind: string
  author: string
  payload: unknown
}

/** Read the real event log through the same JWT → sync-token boundary as the SPA. */
export async function readSeededFileEvents(
  jwt: string,
  projectId: string,
  fileId: string,
): Promise<SeededFileEvent[]> {
  const token = await mintSyncToken(jwt, projectId, fileId)
  const response = await fetch(`${SYNC_BASE}/events?fileId=${encodeURIComponent(fileId)}&limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`event read failed: HTTP ${response.status} — ${await response.text()}`)
  }
  return ((await response.json()) as { events: SeededFileEvent[] }).events
}

/** Create a project and import a markdown or USFM fixture entirely server-side.
 * `jwt` comes from the fixture's session (the stack-namespaced sidecar is
 * written by ensureAuthState; pass `session.jwt` or re-read the sidecar). */
export async function seedProjectWithFile(
  jwt: string,
  opts: { name?: string; fixturePath?: string; steeringContext?: boolean } = {},
): Promise<SeededProject> {
  const projectId = randomUUID()
  const projectName = opts.name ?? `Seeded ${projectId.slice(0, 8)}`
  await createProjectServerSide(jwt, { id: projectId, name: projectName })
  // A seeded project stands in for one a team has actually set up: autopilot
  // refuses to start without both languages and an answered brief question
  // (AQU-827). Pass `steeringContext: false` to seed the unconfigured project
  // a spec covering that gate needs.
  if (opts.steeringContext !== false) {
    await updateProjectSettings(jwt, projectId, {
      sourceLanguage: "en",
      targetLanguage: "sw",
      translationBrief: { parameters: { purpose: "Seeded fixture project" } },
    })
  }

  const fileId = randomUUID()
  const fixturePath = opts.fixturePath ?? DEFAULT_FIXTURE
  const fileName = path.basename(fixturePath)
  const fileType = path.extname(fixturePath).toLowerCase() === ".usfm" ? "usfm" : "md"
  const contents = await fs.readFile(fixturePath, "utf8")
  const strings = fileType === "usfm"
    ? extractUsfmStrings(contents).flatMap((book) => book.strings)
    : extractMarkdownStrings(contents)
  const normalized = normalizeTranslatableStrings(strings, { fileName, fileType })

  // Mirror src/lib/import.ts buildBulkCells: chain via anchorCellId, thread
  // sequenceIndex + paragraphStart, keep the parser-minted cell ids.
  let prevCellId: string | null = null
  const cells = strings.map((str, seq) => {
    const unit = normalized.units[seq]
    const cell = {
      id: randomUUID(),
      cellId: str.id,
      anchorCellId: prevCellId,
      value: unit.sourceText,
      ...(unit.sourceHtml ? { valueHtml: unit.sourceHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(unit.canonicalRef ? { canonicalRef: unit.canonicalRef } : {}),
      sequenceIndex: seq,
      // useCells reads paragraphStart from `source.metadata.paragraphStart`
      // (src/hooks/useCells.ts), not the top-level field — mirror
      // buildBulkCellsWithSpeakers (src/lib/import.ts), which sets both.
      ...(str.paragraphStart ? { paragraphStart: true } : {}),
      metadata: {
        ...str.metadata,
        aquillaImport: aquillaImportMetadata(normalized, unit),
        ...(str.paragraphStart ? { paragraphStart: true } : {}),
      },
    }
    prevCellId = str.id
    return cell
  })

  const token = await mintSyncToken(jwt, projectId, fileId)
  const importHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
  const file = {
    id: randomUUID(),
    name: fileName,
    fileType,
    role: "source",
    kind: fileType,
    importFormat: fileType,
    parserVersion: "workspace-import-v1",
  }
  // Match the route's 5,000-cell request limit. Keep the global anchor chain
  // and sequence indexes, and create file metadata only with the first batch.
  for (let offset = 0; offset < Math.max(1, cells.length); offset += 5_000) {
    await postIdempotentJson({
      url: `${SYNC_BASE}/import`,
      headers: importHeaders,
      body: {
        projectId, fileId,
        ...(offset === 0 ? { file } : {}),
        cells: cells.slice(offset, offset + 5_000),
        clientTs: Date.now(),
      },
      operation: `bulk import batch ${offset / 5_000 + 1}`,
    })
  }
  await postIdempotentJson({
    url: `${SYNC_BASE}/import`,
    headers: importHeaders,
    body: { projectId, fileId, cells: [], complete: true },
    operation: "import finalize",
  })

  return { projectId, projectName, fileId, fileName, cellIds: strings.map((s) => s.id) }
}

/** The projected-row fields specs assert on; the route returns more. */
export interface ProjectedCellRow {
  cellId: string
  side: "source" | "target"
  value: string
  validated: boolean
  aiDrafted: boolean
  /** Chain head for this side/lane — the event id the projection last applied. */
  eventId: string
}

/** Read a seeded file's cell rows straight from the sync-worker projection —
 * the authoritative post-event state, not the DOM. Use this for provenance
 * flags with no visible chrome (AQU-1041 removed the AI-draft tag from the
 * cell header, but `aiDrafted` still crosses commit → projection → reads). */
export async function readProjectedCells(
  jwt: string,
  seeded: Pick<SeededProject, "projectId" | "fileId">,
  side?: "source" | "target",
): Promise<ProjectedCellRow[]> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const url = new URL(
    `${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`,
  )
  if (side) url.searchParams.set("side", side)
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`cells read failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { cells: ProjectedCellRow[] }).cells
}

/** The projected-concept fields specs assert on; the route returns more. */
export interface ProjectedConceptRow {
  conceptId: string
  sourceTerm: string
  renderings: Array<{ rendering: string; status: string }>
  notes: string | null
  status: "active" | "draft" | "deprecated"
}

/** Read a project's LIVE (non-tombstoned) termbase straight from the
 * sync-worker projection, as the JWT's user — the same read every other member's
 * glossary hydrates from, so it proves a term.* write landed for them too and
 * is not just the writer's optimistic state. */
export async function readProjectedConcepts(
  jwt: string,
  projectId: string,
): Promise<ProjectedConceptRow[]> {
  // Any file scope works — the route verifies the project only (see useConcepts).
  const token = await mintSyncToken(jwt, projectId, "any")
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${encodeURIComponent(projectId)}/concepts`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) throw new Error(`concepts read failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { concepts: ProjectedConceptRow[] }).concepts
}

/** One event on a cell's chain as returned by the per-cell history route
 * (sync-worker `cell-history-read-route.ts`), newest-first. */
export interface CellHistoryEventRow {
  id: string
  parentId: string | null
  kind: string
  author: string
  serverSeq: number
  payload: unknown
}

/** Read a cell's full event log (newest-first) from
 * `GET /api/v1/projects/:p/files/:f/cells/:c/history` — the audit truth the
 * history drawer renders. Stale (bumped) commits are in here too: they never
 * advanced the projection but are still logged. */
export async function readCellHistory(
  jwt: string,
  seeded: Pick<SeededProject, "projectId" | "fileId">,
  cellId: string,
  limit = 200,
): Promise<CellHistoryEventRow[]> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const url =
    `${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}` +
    `/cells/${encodeURIComponent(cellId)}/history?limit=${limit}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`cell history read failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { events: CellHistoryEventRow[] }).events
}

/** Navigate an authed page straight into the seeded file's editor and wait
 * for cells to render. Replaces createProject + openProject + importFile +
 * openFileBySubstring + waitForEditor. */
export async function openSeededProject(page: Page, seeded: SeededProject): Promise<Workspace> {
  const cellsPath = `/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`
  const cellsLoaded = page.waitForResponse((response) => {
    if (response.request().method() !== "GET") return false
    const url = new URL(response.url())
    return url.pathname === cellsPath && url.searchParams.get("paired") === "1"
  }, { timeout: 60_000 })

  await page.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  const cellsResponse = await cellsLoaded
  if (!cellsResponse.ok()) {
    throw new Error(
      `Seeded complete rows failed to load: HTTP ${cellsResponse.status()} — ${await cellsResponse.text()}`,
    )
  }
  const payload = await cellsResponse.json() as {
    cells?: Array<{ cellId?: string }>
  }
  const firstCellId = seeded.cellIds[0]
  if (!firstCellId || !payload.cells?.some((cell) => cell.cellId === firstCellId)) {
    throw new Error(
      `Seeded complete-row response did not contain expected first cell ${firstCellId ?? "<missing>"}`,
    )
  }

  const ws = new Workspace(page)
  await ws.waitForEditor(firstCellId)
  return ws
}
