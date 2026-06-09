import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ColorThemePicker in workspace OverflowMenu.
 *
 * The WorkspaceHeader OverflowMenu (aria-label="More") contains a
 * ColorThemePicker with four buttons:
 *   aria-label="Color theme: Blue" (default, aria-pressed="true")
 *   aria-label="Color theme: Warm"
 *   aria-label="Color theme: Sage"
 *   aria-label="Color theme: Rose"
 *
 * This spec: open the workspace header overflow menu → verify "Blue" is
 * initially selected → click "Warm" → Warm becomes aria-pressed="true".
 */
test("color theme picker in workspace header overflow switches theme", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Theme ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the workspace "More" overflow menu.
  const moreBtn = alice.getByRole("button", { name: /^More$/i }).first()
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  // ColorThemePicker renders inside the overflow.
  const blueBtn = alice.getByRole("button", { name: /Color theme: Blue/i })
  await expect(blueBtn).toBeVisible({ timeout: 3_000 })
  await expect(blueBtn).toHaveAttribute("aria-pressed", "true")

  // Click "Warm" — it becomes active.
  const warmBtn = alice.getByRole("button", { name: /Color theme: Warm/i })
  await expect(warmBtn).toBeVisible({ timeout: 3_000 })
  await warmBtn.click()
  await expect(warmBtn).toHaveAttribute("aria-pressed", "true")
  await expect(blueBtn).toHaveAttribute("aria-pressed", "false")

  // Reset to Blue so we don't pollute other tests.
  await blueBtn.click()
  await expect(blueBtn).toHaveAttribute("aria-pressed", "true")
})
