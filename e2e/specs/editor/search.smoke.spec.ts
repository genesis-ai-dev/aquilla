import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Search panel (ParallelPassagesPanel in "search" mode).
 *
 * Tests:
 *  1. The panel opens when the toolbar Search & replace button is clicked.
 *  2. The search input accepts text and returns "No results" for a garbage query.
 *  3. The panel can be dismissed with Escape.
 *
 * The search index is built lazily after the panel opens; an unmatched query
 * should reliably surface "No results for …" once the index is ready.
 */
test("search panel opens, accepts a query, and shows no-results for unmatched text", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Search ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // 1. Open the search panel via the toolbar button.
  const searchBtn = alice.locator('button[aria-label="Search & replace"]')
  await expect(searchBtn).toBeVisible({ timeout: 5_000 })
  await searchBtn.click()

  // The panel is rendered as a Dialog.
  const panel = alice.getByRole("dialog")
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // 2. The only textbox in the dialog is the search input.
  const input = panel.getByRole("textbox").first()
  await expect(input).toBeVisible({ timeout: 5_000 })

  // Type a query that definitely won't match any cell content.
  const needle = `zzz-no-match-${Date.now()}`
  await input.fill(needle)

  // The panel shows "No results for …" once the index is built and the query returns nothing.
  await expect(panel.getByText(/No results for/i)).toBeVisible({ timeout: 10_000 })

  // 3. Dismiss with Escape.
  await alice.keyboard.press("Escape")
  await expect(panel).not.toBeVisible({ timeout: 5_000 })
})
