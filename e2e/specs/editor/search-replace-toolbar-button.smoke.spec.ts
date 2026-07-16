import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Search affordance — dock Search tab opens the parallel panel.
 *
 * AQU-308 replaced the old workspace-toolbar "Search & replace" button with
 * a Search tab in the left dock rail (LeftDock.tsx). The dock hosts
 * SearchDockPanel (quick inline search); its "Open full search panel" button
 * opens the full ParallelPassagesPanel dialog:
 *   setParallelMode("search")
 *   setParallelScope("file" | "project")
 *   setParallelOpen(true)
 *
 * This spec:
 *   1. Imports sample.md, opens editor.
 *   2. Clicks the dock rail Search tab — the inline SearchDockPanel appears
 *      with its own search input.
 *   3. Clicks "Open full search panel" — the ParallelPassagesPanel dialog
 *      becomes visible with a search/query input.
 */
test("dock Search tab and Open full search panel open the parallel panel", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SearchBtn ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click the dock rail Search tab.
  await alice.getByRole("button", { name: "Search", exact: true }).click()

  // The inline dock panel has a search input.
  const dockInput = alice.locator('input[placeholder*="Search" i]').first()
  await expect(dockInput).toBeVisible({ timeout: 5_000 })

  // Open the full ParallelPassagesPanel dialog.
  const openFullBtn = alice.getByRole("button", { name: "Open full search panel" })
  await expect(openFullBtn).toBeVisible({ timeout: 5_000 })
  await openFullBtn.click()

  // The dialog contains its own search/query input.
  const panel = alice.getByRole("dialog")
  await expect(panel).toBeVisible({ timeout: 5_000 })
  const searchInput = panel.locator('input[placeholder*="Search" i], input[aria-label*="Search" i]').first()
  await expect(searchInput).toBeVisible({ timeout: 5_000 })
})
