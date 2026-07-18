import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/** A manual direction that conflicts with committed text can be dismissed
 * without changing the user's explicit direction choice. */
test("manual target direction mismatch warning can be dismissed", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RtlHint ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  await ws.editCell(0, "مرحبا بالعالم")
  await ws.openViewSettingsMenu()
  await alice.getByRole("menu").getByRole("button", { name: "Target direction LTR" }).click()
  await alice.keyboard.press("Escape")

  const warning = alice.locator('[role="status"]').filter({ hasText: /content looks right-to-left/i })
  await expect(warning).toContainText(/Target is forced left-to-right/i, { timeout: 5_000 })
  await warning.getByRole("button", { name: "Dismiss direction warning" }).click()
  await expect(warning).not.toBeVisible({ timeout: 3_000 })

  // Dismissal does not silently change the user's manual override.
  await ws.openViewSettingsMenu()
  await expect(alice.getByRole("menu").getByRole("button", { name: "Target direction LTR" }))
    .toHaveAttribute("aria-pressed", "true")
})
