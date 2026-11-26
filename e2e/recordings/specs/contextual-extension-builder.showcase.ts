import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { setProjectLanguagePair } from "../../helpers/frontier-api"
import { resetBackend } from "../../helpers/seed"
import { commitTargetServerSide, jwtFor, openSeededProject, readProjectedCells, seedProjectWithFile } from "../../helpers/seed-project"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Showcase } from "../helpers/showcase"

async function cleanShot(page: Page, dir: string, name: string): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("__showcase_chapter")?.classList.remove("on")
    document.getElementById("__showcase_caption")?.classList.remove("on")
    const bug = document.getElementById("__showcase_bug")
    const cursor = document.getElementById("__showcase_cursor")
    if (bug) bug.style.opacity = "0"
    if (cursor) cursor.style.opacity = "0"
  })
  await page.waitForTimeout(450)
  await page.screenshot({ path: path.join(dir, name) })
  await page.evaluate(() => {
    const bug = document.getElementById("__showcase_bug")
    const cursor = document.getElementById("__showcase_cursor")
    if (bug) bug.style.opacity = ""
    if (cursor) cursor.style.opacity = ""
  })
}

/**
 * AQU-2772 · Contextual Smart Extension Creation & Placement-Aware Builder
 *
 * Captures a live walkthrough video (1280×800) and 6 screenshots showing every
 * contextual "+ Build a…" trigger landing in `/extensions?where=<surface>&fileId=<id>`
 * with pre-selected placement, tailored placeholder, and surface-specific chips:
 *
 *   01-import-build-importer.png   — Import dialog showing "+ Build a custom importer…"
 *   02-builder-importer-preset.png — /extensions?where=importer with Importer selected + importer suggestions
 *   03-export-build-exporter.png   — Export dialog showing "+ Build a custom export format…"
 *   04-builder-exporter-preset.png — /extensions?where=exporter with Exporter selected + exporter suggestions
 *   05-editor-dock-and-inline.png  — Editor showing "+ Add column or check", empty dock "+ Build a side panel…", & cell Extensions tab "+ Build a verse extension…"
 *   06-builder-column-preset.png   — /extensions?where=column with "In the editor" selected + column/checker suggestions
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SHOTS_DIR = path.resolve(__dirname, "../output/aqu-2772-contextual-builder-shots")

test("Contextual Smart Extension Creation & Placement-Aware Builder (AQU-2772)", async ({ page }) => {
  test.setTimeout(180_000)
  rmSync(SHOTS_DIR, { recursive: true, force: true })
  mkdirSync(SHOTS_DIR, { recursive: true })

  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)

  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, {
    smartExtensions: true,
    steeringContext: false,
    name: "Matthew (Spanish)",
    fixturePath: FIXTURE,
  })
  await setProjectLanguagePair(jwt, seeded.projectId, {
    sourceLanguage: "English",
    sourceCode: "en",
    targetLanguage: "Spanish",
    targetCode: "es",
    translationBrief: { parameters: { purpose: "Spanish Gospel translation" } },
  })
  const sourceCells = await readProjectedCells(jwt, seeded, "source")
  const mat11 = sourceCells.find((r) => r.value.includes("genealogy"))?.cellId ?? seeded.cellIds[1]!
  await commitTargetServerSide(jwt, seeded, mat11, "Libro de la genealogía de Jesús, hijo de David.", "alice")

  const ws = new Workspace(page)
  const show = new Showcase(page, {
    persona: "aqu-2772",
    feature: "contextual-extension-builder",
    title: "Build Smart Extensions Right Where You Need Them (AQU-2772)",
    cta: "Start building from Import, Export, the Editor bar, Side panel, or any verse.",
    mode: "doc",
  })

  let verified = false
  try {
    await openSeededProject(page, seeded)

    // 1. Import dialog -> "+ Build a custom importer…" -> /extensions?where=importer
    await show.chapter("Start from Import", "Build a custom importer right from the Import dialog")
    await ws.openImportDialog()
    const buildImporter = page.getByTestId("build-extension-importer")
    await expect(buildImporter).toBeVisible({ timeout: 15_000 })
    await buildImporter.scrollIntoViewIfNeeded()
    await show.caption("Import dialog offers '+ Build a custom importer…' right under From extensions.")
    await cleanShot(page, SHOTS_DIR, "01-import-build-importer.png")

    await buildImporter.click()
    await expect(page.getByRole("radio", { name: "Importer" })).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
    await expect(page.getByRole("button", { name: /Book glossary importer/ })).toBeVisible()
    await show.caption("The builder pre-selects Importer and adapts the placeholder and example chips.")
    await cleanShot(page, SHOTS_DIR, "02-builder-importer-preset.png")

    // 2. Return to editor -> Export dialog -> "+ Build a custom export format…" -> /extensions?where=exporter
    await page.getByRole("link", { name: "Back to editor" }).click()
    await ws.waitForEditor(seeded.cellIds[0])
    await show.chapter("Start from Export", "Build a custom export format right from the Export dialog")
    await ws.openExportDialog()
    const buildExporter = page.getByTestId("build-extension-exporter")
    await expect(buildExporter).toBeVisible({ timeout: 15_000 })
    await buildExporter.scrollIntoViewIfNeeded()
    await show.caption("Export dialog offers '+ Build a custom export format…' even before any exporter is installed.")
    await cleanShot(page, SHOTS_DIR, "03-export-build-exporter.png")

    await buildExporter.click()
    await expect(page.getByRole("radio", { name: "Exporter" })).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
    await expect(page.getByRole("button", { name: /Annotated TSV export/ })).toBeVisible()
    await show.caption("Exporter is pre-selected with exporter-specific prompt ideas — and Back returns to your open file.")
    await cleanShot(page, SHOTS_DIR, "04-builder-exporter-preset.png")

    // 3. Back to file -> Editor bar "+ Add column or check", Left dock "+ Build a side panel…", & Cell details "+ Build a verse extension…"
    await page.getByRole("link", { name: "Back to editor" }).click()
    await expect(page.getByTestId("build-extension-column")).toBeVisible({ timeout: 15_000 })
    await show.chapter("Start from the Editor, Dock, or any Verse", "Every mount surface has a direct '+ Build…' entry point")

    // Open Smart Extensions left dock tab (empty state shows "+ Build a side panel…")
    await page.getByRole("button", { name: "Smart Extensions", exact: true }).first().click()
    await expect(page.getByTestId("build-extension-panel-empty")).toBeVisible({ timeout: 10_000 })

    // Expand MAT 1:1 -> open Extensions tab (empty state shows "+ Build a verse extension…")
    const mat11Row = page.locator(`[data-cell-id="${mat11}"]`).first()
    await mat11Row.locator('[data-editor-cell-surface="target"]').first().click()
    await mat11Row.getByRole("button", { name: "Open cell details" }).click()
    await mat11Row.getByRole("tab", { name: "Extensions" }).click()
    await expect(mat11Row.getByTestId("build-extension-inline")).toBeVisible({ timeout: 10_000 })
    await show.caption("The Extensions bar, Side panel dock, and per-verse Extensions tab each offer contextual creation.")
    await cleanShot(page, SHOTS_DIR, "05-editor-dock-and-inline.png")

    // Click "+ Add column or check" -> /extensions?where=column&fileId=...
    await page.getByTestId("build-extension-column").click()
    await expect(page.getByRole("radio", { name: "In the editor" })).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
    await expect(page.getByRole("button", { name: /Study notes & checker/ })).toBeVisible()
    await show.caption("Choosing '+ Add column or check' pre-selects In the editor with native column & quick-fix suggestions.")
    await cleanShot(page, SHOTS_DIR, "06-builder-column-preset.png")

    verified = true
    await show.beat(800)
  } finally {
    await show.save(verified)
  }
})
