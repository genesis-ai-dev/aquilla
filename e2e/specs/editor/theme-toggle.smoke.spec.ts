import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ThemeToggle in workspace OverflowMenu.
 *
 * The WorkspaceHeader OverflowMenu (aria-label="More") contains a Theme row
 * with a ThemeToggle button. The button cycles: system → light → dark → system.
 * Its aria-label describes the current mode:
 *   - "Theme: system (light|dark). Click for light."
 *   - "Theme: light. Click for dark."
 *   - "Theme: dark. Click for system."
 *
 * This spec: open the workspace → open More menu → find the ThemeToggle button
 * → click it → verify aria-label changes to a different mode string.
 */
test("theme toggle in workspace overflow menu cycles through modes", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ThemeToggle ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the "More" overflow menu.
  const moreBtn = alice.getByRole("button", { name: /^More$/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  // The ThemeToggle button is visible (aria-label starts with "Theme:").
  const themeBtn = alice.locator('button[aria-label^="Theme:"]')
  await expect(themeBtn).toBeVisible({ timeout: 3_000 })

  // Record the initial label.
  const initialLabel = await themeBtn.getAttribute("aria-label")
  expect(initialLabel).toMatch(/Theme:/i)

  // Click the toggle — label should change to the next mode.
  await themeBtn.click()
  const updatedLabel = await themeBtn.getAttribute("aria-label")
  expect(updatedLabel).toMatch(/Theme:/i)
  expect(updatedLabel).not.toBe(initialLabel)
})
