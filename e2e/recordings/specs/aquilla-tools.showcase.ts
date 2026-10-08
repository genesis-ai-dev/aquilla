import { test, expect, type FrameLocator, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, mintSyncToken, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"

/**
 * Aquilla Tools (prototype) walkthrough, 1280×720.
 *
 * Open Tools → ask the builder (the REAL model unless TOOLS_SHOWCASE_STARTER=1)
 * for a Key-Term Heat Map → it is linted and smoke-rendered in a sandbox →
 * install it with read-only standing grants → its first write asks for
 * permission → bulk harmonize → attributed activity → revert since T.
 *
 * Writes `<outputDir>/timeline.json` (build start/end, which tool was driven)
 * so the take can be trimmed around the model wait.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const FRAME = { width: 1280, height: 720 }
const USE_STARTER = process.env.TOOLS_SHOWCASE_STARTER === "1"

const BUILD_PROMPT =
  "Build me a Key-Term Heat Map: a term × chapter grid for one file. Rows are key terms (termbase terms plus terms I track), " +
  "columns are chapters; each grid cell shows k/n — n verses in that chapter whose source mentions the term, k of them whose " +
  "target uses the preferred rendering — coloured green/amber/red. To track a term, give me inputs labelled exactly " +
  "'Source term', 'Preferred rendering' and 'Variants' (comma-separated) and a 'Track term' button; keep tracked terms in " +
  "aquilla.storage. Each term row starts with a button labelled 'Select term <term>'. Selecting a term previews every cell " +
  "where a variant would be replaced by the preferred rendering (whole word, case-insensitive, Unicode-aware) and shows one " +
  "button whose text starts with 'Harmonize' that writes them all in a single aquilla.cells.commit call. Add a <select> labelled 'File'."

test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

async function seedTargets(jwt: string, seeded: SeededProject): Promise<void> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const read = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const rows = ((await read.json()) as { cells: { cellId: string; side: string; canonicalRef: string | null; eventId: string }[] }).cells
  const byRef = new Map(rows.filter((r) => r.side === "source").map((r) => [r.canonicalRef, r]))
  const targets: Record<string, string> = {
    "MAT 1:1": "Libro de la genealogía de Jesús, hijo de David.",
    "MAT 1:2": "Abraham engendró a Isaac.",
    "MAT 1:3": "José llamó al niño Jesus.",
    "MAT 2:1": "Jesu nació en Belén de Judea.",
    "MAT 2:2": "Unos sabios vinieron a adorar a Jesus.",
    "MAT 2:3": "Herodes se turbó.",
  }
  const events = Object.entries(targets).map(([ref, value]) => {
    const src = byRef.get(ref)
    if (!src) throw new Error(`fixture has no ${ref}`)
    return {
      id: randomUUID(), schemaVersion: 1, projectId: seeded.projectId, fileId: seeded.fileId, cellId: src.cellId,
      parentId: src.eventId, kind: "target.cell.commit", author: "alice", payload: { value, targetLang: "sw" }, clientTs: Date.now(),
    }
  })
  const res = await fetch(`${SYNC_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
  expect(res.status).toBe(200)
}

async function driveHeatMap(page: Page, frame: FrameLocator, tools: ToolsPage): Promise<void> {
  await frame.getByLabel("Source term").fill("Jesus")
  await frame.getByLabel("Preferred rendering").fill("Jesús")
  await frame.getByLabel(/^Variants/).fill("Jesus, Jesu")
  await frame.getByRole("button", { name: "Track term" }).click()
  const select = frame.getByRole("button", { name: /Select term Jesus/ })
  if (await select.count()) await select.first().click()
  const harmonize = frame.getByRole("button", { name: /^Harmonize/ })
  await expect(harmonize).toBeEnabled({ timeout: 15_000 })
  await page.waitForTimeout(1200) // let the viewer read the preview
  await harmonize.click()
  await expect(tools.permissionPrompt()).toBeVisible()
  await page.waitForTimeout(1200)
  await tools.answerPrompt("Always allow")
}

test("Aquilla Tools — build, permit, harmonize, attribute, revert", async ({ page }, testInfo) => {
  test.setTimeout(900_000)
  const t0 = Date.now() // ≈ video start: the page fixture opened just before the body
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)

  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Matthew (Spanish)", fixturePath: FIXTURE })
  await seedTargets(jwt, seeded)

  const tools = new ToolsPage(page)
  const timeline: Record<string, number | string> = { mode: USE_STARTER ? "starter" : "builder" }
  await tools.open(seeded.projectId)
  timeline.toolsOpen = Date.now() - t0
  await page.waitForTimeout(1000)

  let toolName = "Key-Term Heat Map"
  if (!USE_STARTER) {
    const box = page.getByRole("textbox", { name: "Build an extension" })
    await box.click()
    await box.pressSequentially(BUILD_PROMPT.slice(0, 120), { delay: 8 })
    await box.fill(BUILD_PROMPT)
    await page.getByRole("button", { name: "Build", exact: true }).click()
    timeline.buildStart = Date.now() - t0
    const dialog = page.getByRole("dialog", { name: /^Install .*\?$/ })
    await expect(dialog).toBeVisible({ timeout: 780_000 })
    timeline.buildEnd = Date.now() - t0
    toolName = ((await dialog.getByRole("heading").first().textContent()) ?? "").replace(/^Install /, "").replace(/\?$/, "")
    await page.waitForTimeout(1500)
    await dialog.getByRole("button", { name: "Install", exact: true }).click()
    await page.waitForURL(/\/extensions\/[0-9a-f-]{36}$/)
  } else {
    await tools.installStarter(toolName)
  }
  timeline.toolName = toolName

  const frame = tools.toolFrame(toolName)
  await expect(frame.getByLabel("Source term")).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  await driveHeatMap(page, frame, tools)
  await page.waitForTimeout(2500)
  timeline.harmonized = Date.now() - t0

  await tools.open(seeded.projectId)
  const activity = await tools.openActivity(toolName)
  await expect(activity.getByTestId("tool-activity-row").first()).toBeVisible()
  await page.waitForTimeout(2500)
  await tools.revertSince(activity)
  await expect(activity.getByRole("status").first()).toContainText("Reverted")
  await page.waitForTimeout(2500)
  timeline.end = Date.now() - t0

  writeFileSync(testInfo.outputPath("timeline.json"), JSON.stringify(timeline, null, 2))
})
