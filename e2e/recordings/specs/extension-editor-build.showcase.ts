import { test, expect } from "@playwright/test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, mintSyncToken, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"

/**
 * Smart Extensions — the REAL builder (Opus 5.5) makes a custom editor:
 * a spreadsheet-style editor that replaces the standard editor for a file.
 * The prompt pins accessible labels so the take can drive whatever it builds.
 * Spends one builder run (≈$0.3). Writes timeline.json for trimming.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const FRAME = { width: 1280, height: 720 }

const PROMPT =
  "Build me a Spreadsheet Editor: a custom editor (mounts: editor and page) that replaces the standard editor for the file in " +
  "aquilla.context.file (fall back to the first file). Show every cell as a spreadsheet row: reference, source text, an editable " +
  "target textarea labelled exactly 'Translation <ref>' (or 'Translation <row number>' when there is no ref), and a button " +
  "labelled exactly 'Validate <ref>' that shows a check once validated. Save a row's textarea on blur and on Ctrl/Cmd+Enter with " +
  "aquilla.cells.commit. A header shows the file name and 'n of m translated' and a filter box labelled 'Filter rows'. Refresh rows " +
  "on cells.changed without overwriting a textarea that has focus. Compact, readable, sticky header row."

test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

test("Smart Extensions — the builder makes a custom editor", async ({ page }, testInfo) => {
  test.setTimeout(900_000)
  const t0 = Date.now()
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Matthew (Spanish)", fixturePath: FIXTURE })

  const tools = new ToolsPage(page)
  await tools.open(seeded.projectId)
  const timeline: Record<string, number | string> = { open: Date.now() - t0 }
  const box = page.getByRole("textbox", { name: "Build an extension" })
  await box.fill(PROMPT)
  await page.getByRole("button", { name: "Build", exact: true }).click()
  timeline.buildStart = Date.now() - t0
  const dialog = page.getByRole("dialog", { name: /^Install .*\?$/ })
  await expect(dialog).toBeVisible({ timeout: 780_000 })
  timeline.buildEnd = Date.now() - t0
  const name = ((await dialog.getByRole("heading").first().textContent()) ?? "").replace(/^Install /, "").replace(/\?$/, "")
  timeline.name = name
  await dialog.getByRole("button", { name: "Install", exact: true }).click()

  await openSeededProject(page, seeded)
  await page.keyboard.press("Control+Shift+E")
  await page.getByRole("option", { name: `${name}: use as editor for this file` }).click()
  const frame = tools.toolFrame(name)
  const cell = frame.getByLabel("Translation MAT 1:1")
  await expect(cell).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  await cell.click()
  await cell.pressSequentially("Libro de la genealogía de Jesucristo.", { delay: 25 })
  await cell.press("Control+Enter")
  await expect(tools.permissionPrompt()).toBeVisible()
  await page.waitForTimeout(800)
  await tools.answerPrompt("Always allow")
  await frame.getByRole("button", { name: "Validate MAT 1:1" }).click()
  await tools.answerPrompt("Always allow")
  await page.waitForTimeout(2500)

  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  await expect.poll(async () => {
    const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, { headers: { Authorization: `Bearer ${token}` } })
    const rows = ((await r.json()) as { cells: { side: string; value: string; validated: boolean }[] }).cells
    return rows.some((c) => c.side === "target" && c.value === "Libro de la genealogía de Jesucristo." && c.validated)
  }).toBe(true)
  timeline.end = Date.now() - t0
  writeFileSync(testInfo.outputPath("timeline.json"), JSON.stringify(timeline, null, 2))
})
