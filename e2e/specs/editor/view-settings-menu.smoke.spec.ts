import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViewSettingsMenu — opened from the workspace header ⋯ overflow (AQU-331).
 *
 * Popover contains toggleable items:
 *   - "Show line numbers" (Switch)
 *   - "Show cell labels" (Switch)
 *   - Text direction: Source and Target (DirPill)
 */
test("view settings menu opens and toggles show line numbers", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ViewSettings ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  await ws.openViewSettingsMenu()

  const panel = alice.getByTestId("view-settings-popover")
  const lineNumbers = panel.getByRole("switch", { name: /Show line numbers/i })
  await expect(lineNumbers).toBeVisible({ timeout: 3_000 })
  await expect(panel.getByRole("switch", { name: /Show cell labels/i })).toBeVisible({ timeout: 3_000 })

  const wasChecked = await lineNumbers.isChecked()
  await lineNumbers.click()
  await expect(lineNumbers).toHaveAttribute("aria-checked", wasChecked ? "false" : "true")
})
