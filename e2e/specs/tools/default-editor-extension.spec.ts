// Smart Extensions: the DEFAULT editor is itself an extension. With the
// first-party "Aquilla Editor" on, opening a file shows it (no install step,
// its scopes auto-granted and SAID so), and it does the standard editor's job
// purely through the sandboxed bridge: rich-text edits committed as ordinary
// events with tool provenance, validate, another person's presence and live
// edit arriving in place, the built-in editor one switch away (and back), and
// "revert everything since then" undoing what it wrote.
//
// Crosses SPA (sandboxed frame + bridge + outbox + project WebSocket + editor
// switcher), auth-worker (server-side first-party install, grants, activity),
// sync-worker (events, provenance stamp, focus-lock DO, broadcast), Postgres,
// and a second browser context (bob).

import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { DEFAULT_EDITOR, ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { jwtFor, mintSyncToken, readCellHistory, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"
import { addProjectMember, ROLE } from "../../helpers/frontier-api"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

interface Row {
  cellId: string
  side: "source" | "target"
  value: string
  valueHtml: string | null
  validated: boolean
  canonicalRef: string | null
}

async function target(jwt: string, seeded: SeededProject, ref: string): Promise<Row | undefined> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(r.ok, await r.clone().text()).toBe(true)
  const rows = ((await r.json()) as { cells: Row[] }).cells
  const src = rows.find((x) => x.side === "source" && x.canonicalRef === ref)
  return rows.find((x) => x.side === "target" && x.cellId === src?.cellId)
}

test("the default editor is a first-party extension that edits, validates, shows live edits and reverts", async ({ alice, bob }) => {
  test.setTimeout(150_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Default editor ${Date.now()}`, fixturePath: FIXTURE })
  await addProjectMember(jwt, seeded.projectId, "bob", ROLE.CONTRIBUTOR)

  const tools = new ToolsPage(alice)
  const bobTools = new ToolsPage(bob)
  await tools.optIntoDefaultEditorExtension()
  await bobTools.optIntoDefaultEditorExtension()

  // Opening the file IS opening the extension editor: no install, no prompt.
  const frame = await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")
  await expect(alice.getByTestId("first-party-notice")).toContainText("granted these permissions automatically")
  await expect(alice.getByRole("combobox", { name: "Edit with" })).toHaveValue(/[0-9a-f-]{36}/)
  await expect(tools.editorRow(frame, "MAT 1:1")).toContainText("The book of the genealogy of Jesus Christ")

  // Edit MAT 1:1 (plain), Tab commits and moves on; MAT 1:2 with bold.
  const v11 = tools.translationBox(frame, "MAT 1:1")
  await v11.click()
  await v11.pressSequentially("Libro de la genealogía de Jesucristo.")
  await v11.press("Tab")
  const v12 = tools.translationBox(frame, "MAT 1:2")
  await expect(v12).toBeFocused()
  await v12.pressSequentially("Abraham ")
  await v12.press("ControlOrMeta+b")
  await v12.pressSequentially("engendró")
  await v12.press("ControlOrMeta+b")
  await v12.pressSequentially(" a Isaac.")
  await v12.press("Enter")
  await expect(tools.permissionPrompt()).toHaveCount(0)

  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:1"))?.value).toBe("Libro de la genealogía de Jesucristo.")
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:2"))?.value).toBe("Abraham engendró a Isaac.")
  expect((await target(jwt, seeded, "MAT 1:2"))?.valueHtml).toMatch(/<b>engendró<\/b>/)
  const t11 = await target(jwt, seeded, "MAT 1:1")
  const history = await readCellHistory(jwt, seeded, t11!.cellId)
  expect(history[0].payload).toMatchObject({ tool_origin: { origin: "tool" } })

  // Validate MAT 1:2 through the extension.
  await tools.editorRow(frame, "MAT 1:2").getByRole("button", { name: "Validate MAT 1:2" }).click()
  await expect(tools.editorRow(frame, "MAT 1:2").getByRole("button", { name: "Unvalidate MAT 1:2" })).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:2"))?.validated).toBe(true)

  // Bob, in his own browser, opens the same file (also the extension editor)
  // and starts on MAT 1:3: alice sees his focus lock, then his text, live.
  const bobFrame = await bobTools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:3")
  const bob13 = bobTools.translationBox(bobFrame, "MAT 1:3")
  await bob13.click()
  await expect(tools.editorRow(frame, "MAT 1:3")).toContainText("bob is editing")
  await expect(tools.translationBox(frame, "MAT 1:3")).toHaveAttribute("contenteditable", "false")
  await bob13.pressSequentially("José le puso por nombre Jesús.")
  await bob13.press("Enter")
  await expect(tools.translationBox(frame, "MAT 1:3")).toHaveText("José le puso por nombre Jesús.")
  await expect(tools.editorRow(frame, "MAT 1:3")).not.toContainText("bob is editing")

  // The built-in editor is one switch away, shows the same text, and back.
  await tools.switchEditor("Standard editor")
  await expect(alice.getByTestId("extension-editor-surface")).toHaveCount(0)
  await expect(alice.getByText("Libro de la genealogía de Jesucristo.").first()).toBeVisible()
  await tools.switchEditor(`${DEFAULT_EDITOR} (default)`)
  await expect(tools.translationBox(tools.toolFrame(DEFAULT_EDITOR), "MAT 1:1")).toHaveText("Libro de la genealogía de Jesucristo.")

  // Revert everything the editor extension wrote since then (24h window).
  await tools.open(seeded.projectId)
  await expect(tools.installedTool(DEFAULT_EDITOR).getByTestId("first-party-badge")).toBeVisible()
  const activity = await tools.openActivity(DEFAULT_EDITOR)
  await expect(activity.getByTestId("tool-activity-row").first()).toContainText("Verified extension write")
  await tools.revertSince(activity)
  await expect(activity.getByRole("status").first()).toContainText("Reverted")
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:1"))?.value ?? "").toBe("")
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:2"))?.value ?? "").toBe("")
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:2"))?.validated ?? false).toBe(false)
})
