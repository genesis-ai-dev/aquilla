import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Toggle validation on the StatusPie trigger — click adds yours, click again removes it.
 * Validator list is hover-only; no trash control in the popover.
 */
test("cell validation button toggles the current user's validation", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Unvalidate ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await ws.editCell(0, "Translation to validate then remove")
  await ws.validateCell(0)

  const row = ws.cellRow(0)
  await row.hover()
  const healthBtn = row.getByRole("button", { name: /Validated/i }).first()
  await expect(healthBtn).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 })

  await healthBtn.click()

  await expect(healthBtn).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 })
})
