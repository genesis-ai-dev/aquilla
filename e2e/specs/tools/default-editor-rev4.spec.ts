// Smart Extensions (AQU-1793, apiRev 4): the last built-in editor surfaces,
// driven in the first-party EXTENSION editor and checked against the server —
// the source selection toolbar (Ask AI opens the host's chat with the
// selection; Add to terminology opens the host's popover), the source cell
// menu (edit the source text in place; hide a cell), the footnote tray fed
// from the frame's visible rows, the audio column voting per take, and the
// Audio lens's waveform.
//
// Crosses SPA (sandboxed frame + bridge + workspace pipeline + host popovers
// and drawers), sync-worker (source.cell.commit / visibility / audio events,
// the audio store), Postgres.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { seedCellAudio } from "../../helpers/seed-audio"
import { readProjectLanes } from "../../helpers/frontier-api"
import { jwtFor, mintSyncToken, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

interface Row { cellId: string; side: "source" | "target"; value: string; canonicalRef: string | null; hidden?: boolean }

async function rows(jwt: string, seeded: SeededProject): Promise<Row[]> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, { headers: { Authorization: `Bearer ${token}` } })
  expect(r.ok).toBe(true)
  return ((await r.json()) as { cells: Row[] }).cells
}

test("the extension editor carries the source toolbar, the source menu, the footnote tray, the audio column and the Audio lens", async ({ alice }) => {
  test.setTimeout(150_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Rev4 ${Date.now()}`, fixturePath: FIXTURE })
  const tools = new ToolsPage(alice)
  await tools.optIntoDefaultEditorExtension()
  await alice.goto("/")
  const frame = await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")
  const row = (ref: string) => tools.editorRow(frame, ref)
  const sourceText = (ref: string) => row(ref).locator("[data-editor-cell-surface=source] .txt")

  // ── Source selection toolbar: Ask AI → the host's chat, with the selection as a chip.
  async function selectSource(ref: string, toX: number) {
    const box = (await sourceText(ref).boundingBox())!
    await alice.mouse.move(box.x + 1, box.y + 8)
    await alice.mouse.down()
    await alice.mouse.move(box.x + toX, box.y + 8, { steps: 6 })
    await alice.mouse.up()
    await expect(row(ref).getByTestId("source-selection-toolbar")).toBeVisible()
  }
  await selectSource("MAT 1:1", 70)
  await row("MAT 1:1").getByTestId("source-selection-toolbar").getByRole("button", { name: /Ask AI/ }).click()
  const chat = alice.getByTestId("agent-mini-chat")
  await expect(chat).toBeVisible()
  await expect(chat).toContainText(/The book/)
  await chat.locator("[data-testid=agent-mini-chat-close], button[aria-label*='Close' i]").first().click()
  await expect(chat).toBeHidden()

  // …and Add to terminology → the host's own popover, prefilled with the selection.
  await selectSource("MAT 1:2", 60)
  await row("MAT 1:2").getByTestId("source-selection-toolbar").getByRole("button", { name: /Add to terminology/ }).click()
  const add = alice.getByRole("dialog").filter({ hasText: "Add to terminology" })
  await expect(add).toBeVisible()
  await expect(add.getByRole("textbox").first()).toHaveValue(/^Abraham/)
  await alice.keyboard.press("Escape")
  await expect(add).toBeHidden()

  // ── Source cell menu: Edit text in place (source.cell.commit), then hide a cell.
  await row("MAT 1:3").hover()
  const menuFor = async (ref: string) => {
    await row(ref).hover()
    const btn = row(ref).locator("[data-testid^=cell-menu-]")
    await expect(btn).toBeVisible()
    await btn.click()
  }
  await menuFor("MAT 1:3")
  await frame.getByTestId("cell-menu-edit-source").click()
  await expect(sourceText("MAT 1:3")).toHaveAttribute("contenteditable", "true")
  await alice.keyboard.press("End")
  await alice.keyboard.type(" (rev)")
  await alice.keyboard.press("Enter")
  await expect.poll(async () => (await rows(jwt, seeded)).find((r) => r.side === "source" && r.canonicalRef === "MAT 1:3")?.value ?? "", { timeout: 15_000 })
    .toMatch(/\(rev\)$/)

  await menuFor("MAT 2:3")
  await frame.getByTestId("cell-menu-toggle-hidden").click()
  await expect.poll(async () => (await rows(jwt, seeded)).find((r) => r.side === "source" && r.canonicalRef === "MAT 2:3")?.hidden ?? false, { timeout: 15_000 }).toBe(true)

  // ── Footnote tray: a footnote added in the frame shows in the host's tray.
  await row("MAT 1:2").hover()
  await row("MAT 1:2").locator("[data-slot=cell-action-rail-overflow]").click()
  await frame.locator(".overflow button[aria-label='Add footnote']").click()
  await frame.getByRole("alertdialog", { name: "Add footnote" }).locator("textarea").fill("Heb. engendró")
  await frame.getByRole("alertdialog", { name: "Add footnote" }).getByRole("button", { name: "Add footnote" }).click()
  await expect(row("MAT 1:2").locator("[data-usfm-footnote]")).toHaveCount(1, { timeout: 15_000 })
  await alice.evaluate((pid) => localStorage.setItem("aquilla:showFootnotesInline:" + pid, "tray"), seeded.projectId)
  await alice.reload()
  await expect(tools.translationBox(frame, "MAT 1:1")).toBeVisible({ timeout: 30_000 })
  const tray = alice.getByRole("region", { name: /footnotes/i })
  await expect(tray).toContainText("Heb. engendró", { timeout: 15_000 })

  // ── Audio column: a recorded take on MAT 1:1 gets its own vote.
  const source = (await rows(jwt, seeded)).find((r) => r.side === "source" && r.canonicalRef === "MAT 1:1")!
  const lanes = await readProjectLanes(jwt, seeded.projectId)
  await seedCellAudio(jwt, { projectId: seeded.projectId, fileId: seeded.fileId, cellId: source.cellId, author: "alice", targetLang: lanes.find((l) => l.role === "target")?.legacyTag ?? "" })
  await alice.reload()
  const audioVote = row("MAT 1:1").getByTestId("audio-validation-button")
  await expect(audioVote).toBeVisible({ timeout: 30_000 })
  await expect(row("MAT 1:2").getByTestId("audio-validation-unavailable")).toBeVisible()
  await audioVote.click()
  await expect(audioVote).toHaveAttribute("data-state", "full", { timeout: 15_000 })

  // ── Audio lens: the take's waveform, play and the voice picker.
  await alice.locator("button, [role=radio], [role=tab]").filter({ hasText: /^\s*Audio\s*$/ }).first().click()
  await expect(row("MAT 1:1").getByTestId("voice-waveform")).toBeVisible({ timeout: 20_000 })
  await expect(row("MAT 1:1").getByRole("button", { name: /Play/ })).toBeVisible()
})
