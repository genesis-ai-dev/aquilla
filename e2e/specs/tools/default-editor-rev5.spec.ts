// Smart Extensions (AQU-1793), after Daniel's 2026-10-12 decision: the
// Aquilla NATIVE editor is everyone's default, and the first-party
// "Aquilla editor (Smart Extension)" extension — server-installed, at feature parity — is an
// opt-in from the "Edit with" picker. Then one apiRev 5 parity item that
// crosses layers: the AI-draft provenance wash (#946) on a real draft (mock
// LLM through the auth-worker, aiDrafted projected by the sync-worker) paints
// the same runs in the native editor and in the extension editor.
//
// The UI-only rev-5 items (integrity-check hover text, the archived-lane
// banner wording, the Align styles menu action) are covered through the
// shipped runtime in src/lib/tools/__tests__/rev5.test.ts, as dev covers
// AQU-1463 / AQU-757 in RTL.
//
// Full-suite (not smoke): prototype surface.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { applyUserProviderOverride } from "../../helpers/mock-llm-server"
import { ToolsPage, DEFAULT_EDITOR } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, mintSyncToken, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const WASH_PREF = "aq.health-score-color-coding.v1"

interface Row { cellId: string; side: "source" | "target"; value: string; aiDrafted?: boolean; canonicalRef: string | null }

async function target(jwt: string, seeded: SeededProject, cellId: string): Promise<Row | undefined> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, { headers: { Authorization: `Bearer ${token}` } })
  expect(r.ok).toBe(true)
  const rows = ((await r.json()) as { cells: Row[] }).cells
  return rows.find((x) => x.side === "target" && x.cellId === cellId)
}

test("the native editor is the default; the extension editor is an opt-in that paints the same provenance wash", async ({ alice }) => {
  test.setTimeout(150_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Rev5 ${Date.now()}`, fixturePath: FIXTURE })
  const tools = new ToolsPage(alice)
  const workspace = new Workspace(alice, "builtin")
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await alice.addInitScript((key) => { try { localStorage.setItem(key, "on") } catch { /* private mode */ } }, WASH_PREF)
  await alice.goto("/")
  await applyUserProviderOverride(alice, alice.username, `${llmBase}/v1`)

  // A fresh browser that never chose an editor gets the NATIVE editor, with
  // the server-installed extension editor offered (not chosen) in "Edit with".
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await workspace.waitForEditor()
  const picker = alice.getByRole("combobox", { name: "Edit with" })
  await expect(picker).toHaveValue("standard")
  // One name per editor: the native one marked (default), the extension by its manifest name.
  await expect(picker.locator("option[value=standard]")).toHaveText("Aquilla editor (default)")
  await expect(picker.locator("option", { hasText: DEFAULT_EDITOR })).toHaveText(DEFAULT_EDITOR)
  await expect(alice.getByTestId("extension-editor-surface")).toHaveCount(0)

  // AI-draft the first row (the book heading) in the native editor: a new
  // project shows the host's "Set up AI" chooser first, then the sparkle
  // drafts (mock LLM).
  const first = workspace.cellRow(0)
  const cellId = (await first.getAttribute("data-cell-id")) ?? ""
  expect(cellId).not.toBe("")
  await workspace.openAiSetupFromFirstCell()
  await workspace.confirmAiSetup()
  await workspace.clickSparkleOnFirstCell()
  await expect.poll(async () => (await target(jwt, seeded, cellId))?.aiDrafted ?? false, { timeout: 20_000 }).toBe(true)

  // The native editor's wash on the draft.
  const nativeWash = first.locator("[data-health-span]")
  await expect(nativeWash.first()).toBeVisible({ timeout: 15_000 })
  const nativeKinds = await nativeWash.evaluateAll((els) => els.map((e) => e.getAttribute("data-health-span")))
  const nativeCount = (kind: string) => nativeKinds.filter((k) => k === kind).length

  // Opt in from the picker: the extension editor takes over this file.
  await tools.switchEditor(DEFAULT_EDITOR)
  const frame = tools.toolFrame(DEFAULT_EDITOR)
  const read = frame.locator(`.cell[data-cell-id="${cellId}"] [data-target-read-view]`)
  await expect(read).toBeVisible({ timeout: 30_000 })
  // Same runs, painted with the CSS Highlight API in the frame.
  await expect(read).toHaveAttribute("data-health-spans", `${nativeCount("supported")}/${nativeCount("guessed")}`)
  const painted = await read.evaluate(() => {
    const css = (globalThis as unknown as { CSS: { highlights?: Map<string, { size: number }> } }).CSS
    return (css.highlights?.get("aq-hs-supported")?.size ?? 0) + (css.highlights?.get("aq-hs-guessed")?.size ?? 0)
  })
  expect(painted).toBe(nativeKinds.length)

  // The choice is remembered for the file; the native "Aquilla editor (default)" goes back.
  await alice.reload()
  await expect(tools.translationBox(tools.toolFrame(DEFAULT_EDITOR), "MAT 1:1")).toBeVisible({ timeout: 30_000 })
  await expect(tools.toolFrame(DEFAULT_EDITOR).locator(`.cell[data-cell-id="${cellId}"] [data-target-read-view]`)).toHaveAttribute("data-health-spans", /\d+\/\d+/)
  await tools.switchEditor("Aquilla editor (default)")
  await expect(alice.getByTestId("extension-editor-surface")).toHaveCount(0)
  await workspace.waitForEditor()
})
