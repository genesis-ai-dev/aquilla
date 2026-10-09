// Smart Extensions (AQU-1793): the richer editor features, driven in the
// first-party EXTENSION editor and checked against the server — AI drafting
// through the host's own pipeline (mock LLM), the host's history and comments
// drawers opened from the frame, a footnote written as raw USFM, Ctrl/Cmd+.
// "next unfinished", the host's selection bar acting on the frame's
// selection, and the validators popover removing a validation.
//
// Crosses SPA (sandboxed frame + bridge + workspace pipeline + host drawers),
// auth-worker (chat proxy for the draft), sync-worker (events, provenance),
// Postgres. Full-suite (not smoke): the editor smokes guard the built-in
// editor and run against the extension with E2E_EDITOR=extension.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { applyUserProviderOverride } from "../../helpers/mock-llm-server"
import { ToolsPage, DEFAULT_EDITOR } from "../../helpers/page-objects/ToolsPage"
import { jwtFor, mintSyncToken, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

interface Row { cellId: string; side: "source" | "target"; value: string; aiDrafted?: boolean; canonicalRef: string | null }

/** The projected target row of a verse, straight from the sync-worker. */
async function target(jwt: string, seeded: SeededProject, ref: string): Promise<Row | undefined> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, { headers: { Authorization: `Bearer ${token}` } })
  expect(r.ok).toBe(true)
  const rows = ((await r.json()) as { cells: Row[] }).cells
  const src = rows.find((x) => x.side === "source" && x.canonicalRef === ref)
  return rows.find((x) => x.side === "target" && x.cellId === src?.cellId)
}

test("the extension editor drafts with AI, opens history and comments, writes a footnote, jumps to the next unfinished cell and drives the selection bar", async ({ alice }) => {
  test.setTimeout(150_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Parity ${Date.now()}`, fixturePath: FIXTURE })
  const tools = new ToolsPage(alice)
  await tools.optIntoDefaultEditorExtension()
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await alice.goto("/")
  await applyUserProviderOverride(alice, alice.username, `${llmBase}/v1`)

  const frame = await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")
  const row = (ref: string) => tools.editorRow(frame, ref)

  // AI draft on MAT 1:1 — the host opens its "Set up AI" chooser first, as the built-in does.
  await row("MAT 1:1").hover()
  await row("MAT 1:1").locator("[data-slot=cell-action-rail] button[aria-label*='AI']").first().click()
  const setup = alice.getByRole("dialog", { name: /Set up AI/i })
  await expect(setup).toBeVisible()
  await setup.getByRole("button", { name: /^Continue$/i }).click()
  await expect(setup).toBeHidden()
  await row("MAT 1:1").hover()
  await row("MAT 1:1").getByRole("button", { name: "Translate with AI" }).click()
  await expect(tools.translationBox(frame, "MAT 1:1")).toContainText("Traducción de prueba", { timeout: 20_000 })
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:1"))?.aiDrafted ?? false, { timeout: 15_000 }).toBe(true)

  // History drawer (host panel) from the rail overflow.
  await row("MAT 1:1").hover()
  await row("MAT 1:1").locator("[data-slot=cell-action-rail-overflow]").click()
  await frame.locator(".overflow button[aria-label='Edit history']").click()
  await expect(alice.getByRole("heading", { name: /Edit history/i }).first()).toBeVisible()

  // Comments drawer (host panel).
  await row("MAT 1:2").hover()
  await row("MAT 1:2").locator("[data-slot=cell-action-rail-overflow]").click()
  await frame.locator(".overflow button[aria-label='Add comment']").click()
  await expect(alice.locator("[data-testid='comments-drawer']").first()).toBeVisible()

  // A footnote on MAT 1:2, stored as raw USFM in the plain value.
  await tools.translationBox(frame, "MAT 1:2").click()
  await alice.keyboard.type("Abraham engendró a Isaac.")
  await alice.keyboard.press("Enter")
  await row("MAT 1:2").hover()
  await row("MAT 1:2").locator("[data-slot=cell-action-rail-overflow]").click()
  await frame.locator(".overflow button[aria-label='Add footnote']").click()
  await frame.getByRole("alertdialog", { name: "Add footnote" }).locator("textarea").fill("Heb. engendró")
  await frame.getByRole("alertdialog", { name: "Add footnote" }).getByRole("button", { name: "Add footnote" }).click()
  await expect.poll(async () => (await target(jwt, seeded, "MAT 1:2"))?.value ?? "", { timeout: 15_000 }).toMatch(/Abraham engendró a Isaac\.\\f \+ \\fr 1:2 \\ft Heb\. engendró\\f\*$/)
  await expect(row("MAT 1:2").locator(".fn")).toHaveCount(1)

  // Ctrl/Cmd+. jumps to the next unfinished cell and opens it for editing.
  await row("MAT 1:2").locator("[data-grid-row]").focus()
  await alice.keyboard.press("ControlOrMeta+.")
  await expect(tools.translationBox(frame, "MAT 1:3")).toHaveAttribute("contenteditable", "true")
  await alice.keyboard.press("Escape")

  // Selecting rows in the frame shows the HOST's selection bar.
  await row("MAT 2:1").locator("[role=checkbox]").click()
  await row("MAT 2:2").locator("[role=checkbox]").click({ modifiers: ["Shift"] })
  const bar = alice.getByRole("toolbar", { name: /actions/i })
  await expect(bar).toContainText("2")

  // The validators popover removes your own validation (MAT 1:2 auto-validated on commit, or validate it).
  const val = tools.validationButton(frame, "MAT 1:2")
  if ((await val.getAttribute("aria-pressed")) !== "true") await val.click()
  await expect(val).toHaveAttribute("aria-pressed", "true")
  await val.click()
  await frame.getByRole("button", { name: "Remove your validation", exact: true }).click()
  await expect(val).toHaveAttribute("aria-pressed", "false")
  void DEFAULT_EDITOR
})
