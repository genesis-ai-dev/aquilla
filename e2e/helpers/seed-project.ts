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
import { gunzipSync } from "node:zlib"
import type { Page } from "@playwright/test"
import { extractMarkdownStrings } from "../../src/lib/parsers/markdown"
import {
  parseHelloaoComplete,
  type HelloaoComplete,
} from "../../src/lib/parsers/helloao"
import { readPersistedSession } from "./auth-state"
import { createProjectServerSide } from "./frontier-api"
import { postIdempotentJson } from "./idempotent-request"
import { Workspace } from "./page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Matches `src/lib/sync/bulk-import.ts` CHUNK so a whole-Bible upload uses
 * the same per-request write txn size as production. */
const IMPORT_CHUNK = 1500
const HELLOAO_BSB_FIXTURE = path.resolve(
  __dirname,
  "../fixtures/helloao/BSB.complete.json.gz",
)

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

interface ImportString {
  id: string
  original: string
  originalHtml?: string
  type?: string
  group?: string
  paragraphStart?: boolean
}

function cellsFromStrings(strings: ImportString[]) {
  let prevCellId: string | null = null
  const cells = strings.map((str, seq) => {
    const cell = {
      id: randomUUID(),
      cellId: str.id,
      anchorCellId: prevCellId,
      value: str.original,
      ...(str.originalHtml ? { valueHtml: str.originalHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(str.group ? { canonicalRef: str.group } : {}),
      sequenceIndex: seq,
      // useCells reads paragraphStart from `source.metadata.paragraphStart`
      // (src/hooks/useCells.ts), not the top-level field — mirror
      // buildBulkCellsWithSpeakers (src/lib/import.ts), which sets both.
      ...(str.paragraphStart ? { paragraphStart: true, metadata: { paragraphStart: true } } : {}),
    }
    prevCellId = str.id
    return cell
  })
  return { cells, cellIds: strings.map((s) => s.id) }
}

interface ImportFileMeta {
  name: string
  fileType: string
  kind: string
  importFormat: string
  parserVersion: string
}

/** POST `/import` in production-sized chunks (file.create on the first). */
async function importCellsIntoProject(
  jwt: string,
  projectId: string,
  cells: ReturnType<typeof cellsFromStrings>["cells"],
  file: ImportFileMeta,
): Promise<{ fileId: string; cellIds: string[] }> {
  const fileId = randomUUID()
  const token = await mintSyncToken(jwt, projectId, fileId)
  const importHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
  const fileRow = { id: randomUUID(), role: "source", ...file }
  for (let offset = 0; offset === 0 || offset < cells.length; offset += IMPORT_CHUNK) {
    const chunk = cells.slice(offset, offset + IMPORT_CHUNK)
    await postIdempotentJson({
      url: `${SYNC_BASE}/import`,
      headers: importHeaders,
      body: {
        projectId,
        fileId,
        cells: chunk,
        clientTs: Date.now(),
        ...(offset === 0 ? { file: fileRow } : {}),
      },
      operation: `bulk import chunk ${offset / IMPORT_CHUNK + 1}`,
    })
  }
  await postIdempotentJson({
    url: `${SYNC_BASE}/import`,
    headers: importHeaders,
    body: { projectId, fileId, cells: [], complete: true },
    operation: "import finalize",
  })
  return { fileId, cellIds: cells.map((c) => c.cellId) }
}

/** Bulk-import markdown as a new file on an existing project (same `/import`
 * path as `seedProjectWithFile`). */
export async function importMarkdownIntoProject(
  jwt: string,
  projectId: string,
  markdown: string,
  fileName: string,
): Promise<{ fileId: string; cellIds: string[] }> {
  const { cells, cellIds } = cellsFromStrings(extractMarkdownStrings(markdown))
  const imported = await importCellsIntoProject(jwt, projectId, cells, {
    name: fileName,
    fileType: "md",
    kind: "md",
    importFormat: "md",
    parserVersion: "workspace-import-v1",
  })
  return { fileId: imported.fileId, cellIds }
}

/** Load the checked-in helloao BSB `complete.json` snapshot and parse it with
 * the same producer as the import dialog (`parseHelloaoComplete`). Does not
 * hit the network. Refresh: see `e2e/fixtures/helloao/README.md`. */
export async function loadHelloaoBsbFixture(): Promise<{
  name: string
  id: string
  strings: ReturnType<typeof parseHelloaoComplete>
}> {
  let gz: Buffer
  try {
    gz = await fs.readFile(HELLOAO_BSB_FIXTURE)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new Error(
        `Missing ${HELLOAO_BSB_FIXTURE}. Snapshot it with the curl in e2e/fixtures/helloao/README.md — this spec must not fetch bible.helloao.org at runtime.`,
      )
    }
    throw error
  }
  const complete = JSON.parse(gunzipSync(gz).toString("utf8")) as HelloaoComplete
  const name = complete.translation.englishName || complete.translation.name || "BSB"
  return { name, id: complete.translation.id, strings: parseHelloaoComplete(complete) }
}

/** Import a helloao translation as a source file in production-sized chunks.
 * Load the fixture with {@link loadHelloaoBsbFixture} first so parse is not
 * confused with write-path latency. */
export async function importHelloaoStringsIntoProject(
  jwt: string,
  projectId: string,
  parsed: { name: string; id: string; strings: ReturnType<typeof parseHelloaoComplete> },
): Promise<{ fileId: string; cellIds: string[] }> {
  const { cells, cellIds } = cellsFromStrings(parsed.strings)
  const imported = await importCellsIntoProject(jwt, projectId, cells, {
    name: `${parsed.name} (${parsed.id})`,
    fileType: "helloao",
    kind: "helloao",
    importFormat: "helloao",
    parserVersion: "workspace-import-v1",
  })
  return { fileId: imported.fileId, cellIds }
}

/** Create a project and import a markdown fixture entirely server-side.
 * `jwt` comes from the fixture's session (the stack-namespaced sidecar is
 * written by ensureAuthState; pass `session.jwt` or re-read the sidecar). */
export async function seedProjectWithFile(
  jwt: string,
  opts: { name?: string; fixturePath?: string } = {},
): Promise<SeededProject> {
  const projectId = randomUUID()
  const projectName = opts.name ?? `Seeded ${projectId.slice(0, 8)}`
  await createProjectServerSide(jwt, { id: projectId, name: projectName })

  const fixturePath = opts.fixturePath ?? DEFAULT_FIXTURE
  const fileName = path.basename(fixturePath)
  const imported = await importMarkdownIntoProject(
    jwt,
    projectId,
    await fs.readFile(fixturePath, "utf8"),
    fileName,
  )

  return {
    projectId,
    projectName,
    fileId: imported.fileId,
    fileName,
    cellIds: imported.cellIds,
  }
}

/** The projected-row fields specs assert on; the route returns more. */
export interface ProjectedCellRow {
  cellId: string
  side: "source" | "target"
  value: string
  validated: boolean
  aiDrafted: boolean
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

/** Navigate an authed page straight into the seeded file's editor and wait
 * for cells to render. Replaces createProject + openProject + importFile +
 * openFileBySubstring + waitForEditor. */
export async function openSeededProject(page: Page, seeded: SeededProject): Promise<Workspace> {
  const sourceCellsPath = `/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`
  const sourceCellsLoaded = page.waitForResponse((response) => {
    if (response.request().method() !== "GET") return false
    const url = new URL(response.url())
    return url.pathname === sourceCellsPath && url.searchParams.get("side") === "source"
  }, { timeout: 60_000 })

  await page.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  const sourceResponse = await sourceCellsLoaded
  if (!sourceResponse.ok()) {
    throw new Error(
      `Seeded source cells failed to load: HTTP ${sourceResponse.status()} — ${await sourceResponse.text()}`,
    )
  }
  const payload = await sourceResponse.json() as {
    cells?: Array<{ cellId?: string }>
  }
  const firstCellId = seeded.cellIds[0]
  if (!firstCellId || !payload.cells?.some((cell) => cell.cellId === firstCellId)) {
    throw new Error(
      `Seeded source response did not contain expected first cell ${firstCellId ?? "<missing>"}`,
    )
  }

  const ws = new Workspace(page)
  await ws.waitForEditor(firstCellId)
  return ws
}
