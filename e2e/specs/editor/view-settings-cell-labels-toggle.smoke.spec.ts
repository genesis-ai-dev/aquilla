import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViewSettingsMenu — "Show cell labels" switch.
 *
 * Clicking the switch fires onCellLabelsChange; the popover stays open.
 * Closing and reopening still reflects the new state.
 */
test("view settings Show cell labels toggle persists state across open/close", async ({
  alice,
}) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CellLabels ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  await ws.openViewSettingsMenu()

  const panel = alice.getByTestId("view-settings-popover")
  const cellLabels = panel.getByRole("switch", { name: /Show cell labels/i })
  await expect(cellLabels).toBeVisible({ timeout: 3_000 })

  const initialChecked = await cellLabels.isChecked()
  await cellLabels.click()
  await expect(cellLabels).toHaveAttribute("aria-checked", initialChecked ? "false" : "true")

  await alice.keyboard.press("Escape")
  await expect(panel).not.toBeVisible({ timeout: 3_000 })

  await ws.openViewSettingsMenu()
  await expect(cellLabels).toBeVisible({ timeout: 3_000 })
  await expect(cellLabels).toHaveAttribute("aria-checked", initialChecked ? "false" : "true")

  await cellLabels.click()
  await alice.keyboard.press("Escape")
  await ws.openViewSettingsMenu()
  await expect(cellLabels).toBeVisible({ timeout: 3_000 })
  await expect(cellLabels).toHaveAttribute("aria-checked", initialChecked ? "true" : "false")
})
