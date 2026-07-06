import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ParallelPassagesPanel — Search mode toggle: Search vs Passages.
 *
 * ParallelPassagesPanel has a "Search mode" SegmentTabs with options:
 *   - "Search" (default, aria-selected="true")
 *   - "Passages" (aria-selected="false")
 *   - "Replace"
 *
 * Clicking "Passages" makes it the active mode.
 */
test("search panel Passages mode toggle changes active mode", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SearchMode ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the search panel. FRO-308: the toolbar "Search & replace" button was
  // replaced by the dock rail Search tab; the full ParallelPassagesPanel
  // dialog opens from the dock panel's "Open full search panel" button.
  await alice.getByRole("button", { name: "Search", exact: true }).click()
  const openFullBtn = alice.getByRole("button", { name: "Open full search panel" })
  await expect(openFullBtn).toBeVisible({ timeout: 5_000 })
  await openFullBtn.click()

  const panel = alice.getByRole("dialog")
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // "Search" mode tab is selected by default.
  const searchTab = panel.getByRole("tab", { name: /^Search$/i })
  await expect(searchTab).toBeVisible({ timeout: 3_000 })
  await expect(searchTab).toHaveAttribute("aria-selected", "true")

  // Click "Passages".
  const passagesTab = panel.getByRole("tab", { name: /^Passages$/i })
  await expect(passagesTab).toBeVisible({ timeout: 3_000 })
  await expect(passagesTab).toHaveAttribute("aria-selected", "false")
  await passagesTab.click()

  // "Passages" is now selected, "Search" is not.
  await expect(passagesTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
  await expect(searchTab).toHaveAttribute("aria-selected", "false")

  // Dismiss.
  await alice.keyboard.press("Escape")
})
