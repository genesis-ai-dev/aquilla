import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ParallelPassagesPanel — scope and side toggle pills.
 *
 * The Search & replace panel (ParallelPassagesPanel) has three PillToggle
 * groups in the "Panel controls" row:
 *   - "Search scope" (Project, File)
 *   - "Search mode" (Search, Passages, Replace[disabled])
 *   - "Content side" (Both, Source, Target)
 *
 * Each pill has aria-pressed reflecting the current value.
 *
 * This spec: opens the panel → verifies "Project" is pressed →
 * clicks "Both" content side → verifies it's pressed → clicks "Source" →
 * "Source" becomes pressed.
 */
test("search panel content side toggle changes aria-pressed", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SearchScope ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open search panel.
  const searchBtn = alice.locator('button[aria-label="Search & replace"]')
  await expect(searchBtn).toBeVisible({ timeout: 5_000 })
  await searchBtn.click()

  const panel = alice.getByRole("dialog")
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // "Project" scope pill is pressed by default.
  const projectPill = panel.getByRole("button", { name: /^Project$/i })
  await expect(projectPill).toBeVisible({ timeout: 3_000 })
  await expect(projectPill).toHaveAttribute("aria-pressed", "true")

  // Content side: "Both" is pressed by default.
  const bothPill = panel.getByRole("button", { name: /^Both$/i })
  await expect(bothPill).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })

  // Click "Source".
  const sourcePill = panel.getByRole("button", { name: /^Source$/i })
  await expect(sourcePill).toBeVisible({ timeout: 3_000 })
  await sourcePill.click()
  await expect(sourcePill).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 })
  await expect(bothPill).toHaveAttribute("aria-pressed", "false")

  // Restore Both.
  await bothPill.click()
  await expect(bothPill).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
