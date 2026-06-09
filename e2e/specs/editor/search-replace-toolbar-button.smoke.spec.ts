import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Workspace toolbar — Search & replace button opens the parallel panel.
 *
 * ProjectWorkspace.tsx toolbar renders a button with:
 *   aria-label="Search & replace"
 *   title="Search & replace (⌘F)"
 *
 * Clicking it calls:
 *   setParallelMode("search")
 *   setParallelScope("file" | "project")
 *   setParallelOpen(true)
 *
 * ParallelPassagesPanel renders with a search input.
 *
 * This spec:
 *   1. Imports sample.md, opens editor.
 *   2. Clicks the Search & replace toolbar button.
 *   3. ParallelPassagesPanel becomes visible with a search/query input.
 */
test("Search & replace toolbar button opens the parallel panel", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SearchBtn ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click the Search & replace toolbar button.
  const searchBtn = alice.locator('button[aria-label="Search & replace"]').first()
  await expect(searchBtn).toBeVisible({ timeout: 5_000 })
  await searchBtn.click()

  // ParallelPassagesPanel should open — it contains a search input or heading.
  const searchInput = alice.locator('input[placeholder*="Search" i], input[aria-label*="Search" i], input[placeholder*="search" i]').first()
  await expect(searchInput).toBeVisible({ timeout: 5_000 })
})
