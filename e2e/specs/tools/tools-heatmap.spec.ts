// Aquilla Tools (prototype) — install the vetted Key-Term Heat Map starter,
// let it bulk-harmonize a term's renderings, prove the writes are attributed
// to the tool (server-verified provenance), then revert everything it did —
// leaving alone the one cell a person edited afterwards.
//
// Crosses SPA (sandboxed tool frame + bridge + permission prompt + outbox),
// auth-worker (tool store, standing grant, activity read), sync-worker
// (events route + provenance stamp) and Postgres.

import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { readProjectLanes } from "../../helpers/frontier-api"
import { jwtFor, mintSyncToken, readCellHistory, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const TOOL = "Key-Term Heat Map"

interface Row {
  cellId: string
  side: "source" | "target"
  value: string
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

/** The seeded project's target lane tag (its legacy_tag, e.g. "Swahili"). */
async function targetLaneTag(jwt: string, projectId: string): Promise<string> {
  const lane = (await readProjectLanes(jwt, projectId)).find((l) => l.role === "target")
  return lane?.legacyTag ?? ""
}

async function commitTargets(jwt: string, seeded: SeededProject, edits: { cellId: string; parentId: string; value: string }[]) {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const targetLang = await targetLaneTag(jwt, seeded.projectId)
  const res = await fetch(`${SYNC_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      events: edits.map((e) => ({
        id: randomUUID(),
        schemaVersion: 1,
        projectId: seeded.projectId,
        fileId: seeded.fileId,
        cellId: e.cellId,
        parentId: e.parentId,
        kind: "target.cell.commit",
        author: "alice",
        payload: { value: e.value, targetLang },
        clientTs: Date.now(),
      })),
    }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  expect(((await res.json()) as { rejected?: unknown[] }).rejected ?? []).toEqual([])
}

const targetsByRef = (rows: Row[]) => {
  const refs = new Map(rows.filter((r) => r.side === "source").map((r) => [r.cellId, r.canonicalRef]))
  return new Map(rows.filter((r) => r.side === "target").map((r) => [refs.get(r.cellId) ?? r.cellId, r]))
}

test("a tool bulk-harmonizes with attribution, and revert-since-T restores everything but a later human edit", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Tools ${Date.now()}`, fixturePath: FIXTURE })

  // Inconsistent renderings of "Jesus" across two chapters.
  const sources = (await readRows(jwt, seeded)).filter((r) => r.side === "source")
  const byRef = new Map(sources.map((r) => [r.canonicalRef, r]))
  const initial: Record<string, string> = {
    "MAT 1:1": "Libro de la genealogía de Jesús, hijo de David.",
    "MAT 1:3": "José llamó al niño Jesus.",
    "MAT 2:1": "Jesu nació en Belén.",
    "MAT 2:2": "Vinieron a adorar a Jesus.",
  }
  await commitTargets(
    jwt,
    seeded,
    Object.entries(initial).map(([ref, value]) => {
      const src = byRef.get(ref)
      if (!src) throw new Error(`fixture has no ${ref}`)
      return { cellId: src.cellId, parentId: src.eventId, value }
    }),
  )

  const tools = new ToolsPage(alice)
  await tools.open(seeded.projectId)
  await tools.installStarter(TOOL)

  // Inside the sandboxed frame: track the term, select it, harmonize.
  const frame = tools.toolFrame(TOOL)
  await frame.getByLabel("Source term").fill("Jesus")
  await frame.getByLabel("Preferred rendering").fill("Jesús")
  await frame.getByLabel("Variants").fill("Jesus, Jesu")
  await frame.getByRole("button", { name: "Track term" }).click()
  await expect(frame.getByRole("table", { name: "Key-term heat map" })).toBeVisible()
  const harmonize = frame.getByRole("button", { name: "Harmonize 3 cell(s)" })
  await expect(harmonize).toBeEnabled()
  await harmonize.click()

  // write:target was left out of the standing grant → the host asks.
  await expect(tools.permissionPrompt()).toContainText(`Allow ${TOOL} to edit translations?`)
  await tools.answerPrompt("Always")

  await expect
    .poll(async () => {
      const t = targetsByRef(await readRows(jwt, seeded))
      return ["MAT 1:3", "MAT 2:1", "MAT 2:2"].map((ref) => t.get(ref)?.value)
    })
    .toEqual(["José llamó al niño Jesús.", "Jesús nació en Belén.", "Vinieron a adorar a Jesús."])

  // Attribution: the server stamped verified tool provenance on each write.
  const harmonized = targetsByRef(await readRows(jwt, seeded))
  const history = await readCellHistory(jwt, seeded, harmonized.get("MAT 2:1")!.cellId)
  expect(history[0].payload).toMatchObject({ value: "Jesús nació en Belén.", tool_origin: { origin: "tool" } })

  // A person edits one harmonized cell afterwards: revert must leave it alone.
  const human = harmonized.get("MAT 2:2")!
  await commitTargets(jwt, seeded, [{ cellId: human.cellId, parentId: human.eventId, value: "Vinieron a adorar a Jesús, el Cristo." }])

  await tools.open(seeded.projectId)
  const permissions = await tools.openPermissions(TOOL)
  await expect(permissions.getByTestId("tool-grant")).toContainText(["Can read files and cells", "Can read the termbase", "Can edit translations"])
  await alice.keyboard.press("Escape")
  const activity = await tools.openActivity(TOOL)
  await expect(activity.getByTestId("tool-activity-row")).toHaveCount(3)
  await expect(activity.getByTestId("tool-activity-row").first()).toContainText("Verified extension write (v1)")

  await tools.revertSince(activity)
  await expect(activity.getByRole("status").first()).toContainText("Reverted 2 cell(s).")
  await expect(activity).toContainText("Skipped 1 cell(s) someone else edited since:")

  await expect
    .poll(async () => {
      const t = targetsByRef(await readRows(jwt, seeded))
      return ["MAT 1:1", "MAT 1:3", "MAT 2:1", "MAT 2:2"].map((ref) => t.get(ref)?.value)
    })
    .toEqual([
      initial["MAT 1:1"],
      initial["MAT 1:3"],
      initial["MAT 2:1"],
      "Vinieron a adorar a Jesús, el Cristo.",
    ])
})
