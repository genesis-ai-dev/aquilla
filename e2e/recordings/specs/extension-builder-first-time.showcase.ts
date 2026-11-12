import { test, expect } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"

/**
 * Smart Extensions (AQU-1793) — a first-time user builds an extension:
 * picks a translation example, says where it should appear, watches it build,
 * tries it on sample verses, adds it, and opens it beside the verses.
 * The model call is answered with a real builder output (word count); lint,
 * smoke, preview and install are real. ≤40s.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const BUILT = path.join(__dirname, "../../fixtures/tools/word-count-built.html")
const FRAME = { width: 1280, height: 800 }
const MANIFEST = { name: "Word Count", description: "Word count per verse and for the file, live.", scopes: ["read:cells"], mounts: ["panel", "page"], apiRev: 5 }

test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

test("Smart Extensions — a first-time user builds one", async ({ page }) => {
  test.setTimeout(240_000)
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { smartExtensions: true, name: "Matthew (Spanish)", fixturePath: FIXTURE })
  const source = await readFile(BUILT, "utf8")
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  await page.route(/\/tools\/build$/, async (route) => {
    await held
    await route.fulfill({ json: { ok: true, source, manifest: MANIFEST, model: "anthropic/claude-opus-5.5", usage: { promptTokens: 9000, completionTokens: 2400, cost: 0.21 } } })
  })

  const tools = new ToolsPage(page)
  await tools.open(seeded.projectId)
  await expect(page.getByTestId("builder-steps")).toBeVisible()
  await page.waitForTimeout(2500)

  // Describe: an example fills the box; say where it goes.
  await page.getByRole("button", { name: "Word count panel" }).click()
  await page.waitForTimeout(1200)
  await page.getByTestId("builder-build").click()

  // Building: their words, the steps, the time it usually takes.
  await expect(page.getByTestId("tool-build-progress")).toBeVisible()
  await page.waitForTimeout(3500)
  release()

  // Try it: the extension running on sample verses.
  const review = page.getByTestId("built-candidate")
  await expect(review).toBeVisible({ timeout: 30_000 })
  await expect(review.getByTestId("extension-preview-frame").contentFrame().locator("body")).toContainText("words", { timeout: 30_000 })
  await page.waitForTimeout(2000)
  await review.getByTestId("extension-preview-frame").scrollIntoViewIfNeeded()
  await page.waitForTimeout(2500)
  await review.getByTestId("candidate-add").scrollIntoViewIfNeeded()
  await page.waitForTimeout(800)
  await tools.addCandidate()
  await page.waitForURL(/\/extensions\/[0-9a-f-]{36}$/)
  await expect(tools.toolFrame("Word Count").locator("body")).toContainText("MAT 1:1", { timeout: 30_000 })
  await page.waitForTimeout(2500)

  // Where they work: open it beside the verses.
  await page.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await new Workspace(page).waitForEditor()
  await page.waitForTimeout(1000)
  await tools.openInSidePanelFromPalette("Word Count")
  const panel = page.getByTestId("tools-dock-panel").frameLocator('iframe[title="Word Count (sandboxed extension)"]')
  await expect(panel.locator("body")).toContainText("words", { timeout: 30_000 })
  await page.waitForTimeout(3500)
})
