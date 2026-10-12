// Smart Extensions (AQU-1793), Daniel 2026-10-12: the first-party
// "Aquilla editor (Smart Extension)" is the DEFAULT editor, at feature parity,
// and ANY user can switch back to the original "Aquilla editor" in one click;
// the original editor also opens by itself when the extension fails to load.
//
// The e2e build pins the default off (VITE_EXTENSION_DEFAULT_EDITOR=off) so
// the native-editor journeys keep the editor they were written for; these
// specs restore the product default per browser (localStorage "on").
//
// 1. Default + one apiRev 5 parity item across layers: the AI-draft provenance
//    wash (#946) on a real draft (mock LLM via the auth-worker, aiDrafted
//    projected by the sync-worker) paints the same runs in both editors.
// 2. A commenter (no write role, no extension grant needed) switches back,
//    and it survives a reload.
// 3. The extension cannot load (its fetch fails): the original editor opens
//    with a notice, nothing to do for the user.
//
// UI-only rev-5 items (integrity-check hover text, the archived-lane banner,
// Align styles) are covered through the shipped runtime in
// src/lib/tools/__tests__/rev5.test.ts; the switch-back rules in
// src/components/tools/ExtensionEditor.switchback.test.tsx.
// Full-suite (not smoke): prototype surface.

import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"
import { test, expect } from "../../helpers/multi-user"
import { applyUserProviderOverride } from "../../helpers/mock-llm-server"
import { addProjectMember, ROLE } from "../../helpers/frontier-api"
import { ToolsPage, DEFAULT_EDITOR } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, mintSyncToken, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const WASH_PREF = "aq.health-score-color-coding.v1"
const ORIGINAL = "Use the original Aquilla editor"

interface Row { cellId: string; side: "source" | "target"; value: string; aiDrafted?: boolean; canonicalRef: string | null }

async function target(jwt: string, seeded: SeededProject, cellId: string): Promise<Row | undefined> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, { headers: { Authorization: `Bearer ${token}` } })
  expect(r.ok).toBe(true)
  const rows = ((await r.json()) as { cells: Row[] }).cells
  return rows.find((x) => x.side === "target" && x.cellId === cellId)
}

/** The product default for this browser (the e2e build pins it off). */
async function productDefault(page: Page): Promise<void> {
  await new ToolsPage(page).optIntoDefaultEditorExtension()
}

test("the Smart Extension editor is the default, the original is one click away, and both paint the same provenance wash", async ({ alice }) => {
  test.setTimeout(150_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Rev5 ${Date.now()}`, fixturePath: FIXTURE })
  const tools = new ToolsPage(alice)
  const workspace = new Workspace(alice, "builtin")
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await productDefault(alice)
  await alice.addInitScript((key) => { try { localStorage.setItem(key, "on") } catch { /* private mode */ } }, WASH_PREF)
  await alice.goto("/")
  await applyUserProviderOverride(alice, alice.username, `${llmBase}/v1`)

  // A user who never chose an editor gets the Smart Extension editor.
  const frame = await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")
  const picker = alice.getByRole("combobox", { name: "Edit with" })
  await expect(picker.locator("option:checked")).toHaveText(`${DEFAULT_EDITOR} (default)`)
  await expect(picker.locator("option[value=standard]")).toHaveText("Aquilla editor")

  // One click back to the original editor.
  await alice.getByRole("button", { name: ORIGINAL }).click()
  await expect(alice.getByTestId("extension-editor-surface")).toHaveCount(0)
  await workspace.waitForEditor()
  await expect(picker).toHaveValue("standard")

  // AI-draft the first row (the book heading) there: a new project shows the
  // host's "Set up AI" chooser first, then the sparkle drafts (mock LLM).
  const first = workspace.cellRow(0)
  const cellId = (await first.getAttribute("data-cell-id")) ?? ""
  expect(cellId).not.toBe("")
  await workspace.openAiSetupFromFirstCell()
  await workspace.confirmAiSetup()
  await workspace.clickSparkleOnFirstCell()
  await expect.poll(async () => (await target(jwt, seeded, cellId))?.aiDrafted ?? false, { timeout: 20_000 }).toBe(true)
  const nativeWash = first.locator("[data-health-span]")
  await expect(nativeWash.first()).toBeVisible({ timeout: 15_000 })
  const nativeKinds = await nativeWash.evaluateAll((els) => els.map((e) => e.getAttribute("data-health-span")))
  const nativeCount = (kind: string) => nativeKinds.filter((k) => k === kind).length

  // Back to the extension from the picker: the same runs, painted with the
  // CSS Highlight API in the frame.
  await tools.switchEditor(`${DEFAULT_EDITOR} (default)`)
  const read = frame.locator(`.cell[data-cell-id="${cellId}"] [data-target-read-view]`)
  await expect(read).toBeVisible({ timeout: 30_000 })
  await expect(read).toHaveAttribute("data-health-spans", `${nativeCount("supported")}/${nativeCount("guessed")}`)
  const painted = await read.evaluate(() => {
    const css = (globalThis as unknown as { CSS: { highlights?: Map<string, { size: number }> } }).CSS
    return (css.highlights?.get("aq-hs-supported")?.size ?? 0) + (css.highlights?.get("aq-hs-guessed")?.size ?? 0)
  })
  expect(painted).toBe(nativeKinds.length)
})

test("a commenter switches back to the original Aquilla editor in one click, and it survives a reload", async ({ bob }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Rev5 commenter ${Date.now()}`, fixturePath: FIXTURE })
  await addProjectMember(jwt, seeded.projectId, "bob", ROLE.COMMENTER)
  const tools = new ToolsPage(bob)
  const workspace = new Workspace(bob, "builtin")
  await productDefault(bob)

  await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")
  await bob.getByRole("button", { name: ORIGINAL }).click()
  await workspace.waitForEditor()
  await expect(bob.getByTestId("extension-editor-surface")).toHaveCount(0)

  await bob.reload()
  await workspace.waitForEditor()
  await expect(bob.getByRole("combobox", { name: "Edit with" })).toHaveValue("standard")
  await expect(bob.getByTestId("extension-editor-surface")).toHaveCount(0)
  await expect(bob.getByRole("button", { name: ORIGINAL })).toHaveCount(0)
})

test("when the Smart Extension editor cannot load, the original Aquilla editor opens instead", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Rev5 fallback ${Date.now()}`, fixturePath: FIXTURE })
  const tools = new ToolsPage(alice)
  const workspace = new Workspace(alice, "builtin")
  await productDefault(alice)
  // First open installs it (server-side, first party).
  await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")

  // Now its code cannot be fetched: the ensure and the detail read both fail.
  await alice.route(/\/api\/v2\/projects\/[^/]+\/tools\/(first-party|[0-9a-f-]{36})$/, (route) =>
    route.request().method() === "GET" || route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "simulated outage" } }) })
      : route.continue())
  await alice.reload()
  await workspace.waitForEditor()
  await expect(alice.getByTestId("extension-editor-fallback")).toHaveText(/couldn't load, so the original Aquilla editor is open/)
  await expect(alice.getByTestId("extension-editor-surface")).toHaveCount(0)
})
