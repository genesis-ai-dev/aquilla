import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AI Setup dialog — per-cell sparkle button when AI is not configured.
 *
 * The CellActionRail has a sparkle (Sparkles icon) button. When the project
 * has no completionSettings configured, its aria-label is "Set up AI to enable"
 * and clicking it opens AiSetupDialog with:
 *   - DialogTitle "Set up AI"
 *   - Description "Choose a provider to enable translation suggestions."
 *
 * This spec verifies the dialog opens from the rail button.
 * It does NOT configure a real AI provider.
 */
test("cell sparkle button opens AI setup dialog when AI not configured", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AiSetup ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Hover the first cell row to reveal the CellActionRail.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // The sparkle button: aria-label is "Set up AI to enable" (no completionSettings).
  const sparkleBtn = row.locator('[aria-label="Set up AI to enable"]')
  await expect(sparkleBtn).toBeVisible({ timeout: 5_000 })
  await sparkleBtn.click()

  // AiSetupDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Set up AI/i })).toBeVisible()
  await expect(
    dialog.getByText(/Choose a provider to enable translation suggestions/i)
  ).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
