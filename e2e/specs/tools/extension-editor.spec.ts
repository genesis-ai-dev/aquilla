// Smart Extensions (prototype) — a custom editor. Install the reviewed Focus
// Editor starter, switch the file to it from the editor switcher, translate and
// validate verses through it (first writes ask for permission), see another
// person's edit arrive live, then switch back to the standard editor, which
// shows the same text. The choice is remembered across a reload.
//
// Crosses SPA (editor switcher + sandboxed editor frame + bridge + outbox +
// project WebSocket), auth-worker (extension store, grants), sync-worker
// (events, provenance stamp, broadcast) and Postgres.

import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { jwtFor, mintSyncToken, openSeededProject, readCellHistory, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"
import { readProjectLanes } from "../../helpers/frontier-api"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const EDITOR = "Focus Editor"

interface Row {
  cellId: string
  side: "source" | "target"
  value: string
  validated: boolean
  canonicalRef: string | null
  eventId: string
}

async function readRows(jwt: string, seeded: SeededProject): Promise<Row[]> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(r.ok, await r.clone().text()).toBe(true)
  return ((await r.json()) as { cells: Row[] }).cells
}

async function target(jwt: string, seeded: SeededProject, ref: string): Promise<Row | undefined> {
  const rows = await readRows(jwt, seeded)
  const src = rows.find((r) => r.side === "source" && r.canonicalRef === ref)
  return rows.find((r) => r.side === "target" && r.cellId === src?.cellId)
}

/** The seeded project's target lane tag (its legacy_tag, e.g. "Swahili"). */
async function targetLaneTag(jwt: string, projectId: string): Promise<string> {
  const lane = (await readProjectLanes(jwt, projectId)).find((l) => l.role === "target")
  return lane?.legacyTag ?? ""
}

test("a custom editor extension replaces the editor, writes with attribution, and updates live", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Custom editor ${Date.now()}`, fixturePath: FIXTURE })

  const tools = new ToolsPage(alice)
  await tools.open(seeded.projectId)
  await tools.installStarter(EDITOR, { landsIn: "editor" })

  await openSeededProject(alice, seeded)
  // No trip to the management page: the extensions palette (Ctrl+Shift+E)
  // offers the installed editor for this file.
  await alice.keyboard.press("Control+Shift+E")
  await alice.getByRole("option", { name: `${EDITOR}: use as editor for this file` }).click()
  const frame = tools.toolFrame(EDITOR)
  const box = frame.getByLabel("Translation")
  // The file opens on its heading cells; jump to the first verse.
  await frame.getByRole("button", { name: "Go to MAT 1:1" }).click()
  await expect(frame.locator(".ref")).toContainText("MAT 1:1")

  // Translate MAT 1:1 → save & next (first write asks), then validate MAT 1:2.
  await box.fill("Libro de la genealogía de Jesucristo.")
  await box.press("Control+Enter")
  await tools.answerPrompt("Always allow")
  await expect(frame.locator(".ref")).toContainText("MAT 1:2")
  await box.fill("Abraham engendró a Isaac.")
  await frame.getByRole("button", { name: "Validate" }).click()
  await tools.answerPrompt("Always allow")
  await expect(frame.getByText("Validated", { exact: true }).first()).toBeVisible()

  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:1"))?.value).toBe("Libro de la genealogía de Jesucristo.")
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:2"))?.validated).toBe(true)
  const t11 = await target(jwt, seeded, "MAT 1:1")
  const history = await readCellHistory(jwt, seeded, t11!.cellId)
  expect(history[0].payload).toMatchObject({ tool_origin: { origin: "tool" } })

  // Someone else edits the verse on screen: the extension shows it live.
  const t12 = await target(jwt, seeded, "MAT 1:2")
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const res = await fetch(`${SYNC_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      events: [{
        id: randomUUID(), schemaVersion: 1, projectId: seeded.projectId, fileId: seeded.fileId, cellId: t12!.cellId,
        parentId: t12!.eventId, kind: "target.cell.commit", author: "alice",
        payload: { value: "Abraham fue padre de Isaac.", targetLang: await targetLaneTag(jwt, seeded.projectId) }, clientTs: Date.now(),
      }],
    }),
  })
  expect(res.status).toBe(200)
  await expect(box).toHaveValue("Abraham fue padre de Isaac.")

  // The choice is remembered; switching back shows the standard editor.
  await alice.reload()
  await expect(tools.toolFrame(EDITOR).getByLabel("Translation")).toBeVisible()
  await tools.switchEditor("Standard editor")
  await expect(alice.getByTestId("extension-editor-surface")).toHaveCount(0)
  await expect(alice.getByText("Libro de la genealogía de Jesucristo.").first()).toBeVisible()
})
