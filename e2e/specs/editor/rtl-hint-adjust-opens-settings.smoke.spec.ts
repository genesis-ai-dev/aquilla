import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/** Auto direction is silent; a conflicting manual override offers an immediate
 * Auto repair that restores content-driven direction. */
test("direction mismatch Auto action restores content-driven target direction", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RtlAdjust ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  await ws.editCell(0, "مرحبا بالعالم")

  // Auto already renders the committed Arabic target RTL without a banner.
  const target = alice.locator('[data-cell-type="target"] [data-target-read-view]').first()
  await expect(target).toHaveAttribute("dir", "rtl")
  await expect(alice.locator('[role="status"]').filter({ hasText: /content looks right-to-left/i })).toHaveCount(0)

  await ws.openViewSettingsMenu()
  const menu = alice.getByRole("menu")
  await menu.getByRole("button", { name: "Target direction LTR" }).click()
  await alice.keyboard.press("Escape")

  const warning = alice.locator('[role="status"]').filter({ hasText: /content looks right-to-left/i })
  await expect(warning).toBeVisible({ timeout: 5_000 })
  await warning.getByRole("button", { name: "Auto", exact: true }).click()

  await expect(warning).not.toBeVisible({ timeout: 3_000 })
  await expect(target).toHaveAttribute("dir", "rtl")
})
