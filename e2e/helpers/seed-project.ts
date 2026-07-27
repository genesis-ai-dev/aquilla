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
import { createProjectServerSide } from "./frontier-api"
import { postIdempotentJson } from "./idempotent-request"
import { Workspace } from "./page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const SYNC_BASE = `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

const DEFAULT_FIXTURE = path.resolve(__dirname, "../fixtures/sample.md")

/** Read the JWT ensureAuthState persisted for this user (the multi-user
 * fixtures mint it before any test body runs, so the sidecar always exists). */
export async function jwtFor(username: "alice" | "bob" | "carol"): Promise<string> {
  const raw = await fs.readFile(path.resolve(__dirname, `../.auth/${username}.json`), "utf8")
  return (JSON.parse(raw) as { jwt: string }).jwt
}

export interface SeededProject {
  projectId: string
  projectName: string
  fileId: string
  fileName: string
  /** cellIds in document order — index-aligned with editor rows. */
  cellIds: string[]
}

async function mintSyncToken(jwt: string, projectId: string, fileId: string): Promise<string> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ projectId, fileId }),
  })
  if (!r.ok) throw new Error(`sync-token failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { token: string }).token
}

/** Create a project and import a markdown fixture entirely server-side.
 * `jwt` comes from the fixture's session (e2e/.auth/<user>.json is written by
 * ensureAuthState; pass `session.jwt` or re-read the sidecar). */
export async function seedProjectWithFile(
  jwt: string,
  opts: { name?: string; fixturePath?: string } = {},
): Promise<SeededProject> {
  const projectId = randomUUID()
  const projectName = opts.name ?? `Seeded ${projectId.slice(0, 8)}`
  await createProjectServerSide(jwt, { id: projectId, name: projectName })

  const fileId = randomUUID()
  const fixturePath = opts.fixturePath ?? DEFAULT_FIXTURE
  const fileName = path.basename(fixturePath)
  const strings = extractMarkdownStrings(await fs.readFile(fixturePath, "utf8"))

  // Mirror src/lib/import.ts buildBulkCells: chain via anchorCellId, thread
  // sequenceIndex + paragraphStart, keep the parser-minted cell ids.
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

  const token = await mintSyncToken(jwt, projectId, fileId)
  const importHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
  const file = {
    id: randomUUID(),
    name: fileName,
    fileType: "md",
    role: "source",
    kind: "md",
    importFormat: "md",
    parserVersion: "workspace-import-v1",
  }
  await postIdempotentJson({
    url: `${SYNC_BASE}/import`,
    headers: importHeaders,
    body: { projectId, fileId, file, cells, clientTs: Date.now() },
    operation: "bulk import",
  })
  await postIdempotentJson({
    url: `${SYNC_BASE}/import`,
    headers: importHeaders,
    body: { projectId, fileId, cells: [], complete: true },
    operation: "import finalize",
  })

  return { projectId, projectName, fileId, fileName, cellIds: strings.map((s) => s.id) }
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
  }, { timeout: 30_000 })

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
