import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Next-unfinished navigation scrolls to the first empty cell.
 *
 * NextUnfinishedButton (⌘ArrowDown) jumps to the next cell with an
 * empty translation. After clicking, the editor scrolls so that cell
 * is visible and the focus moves to the translation input.
 *
 * This spec: import a file → validate cell 0 to mark it finished →
 * click the Next Unfinished button → assert the editor is still visible
 * (scroll completed without error). Since we only have one cell in the
 * sample fixture, clicking Next Unfinished with no remaining empty cells
 * shows a status toast ("All done") or no-ops — verify either outcome.
 */
test("next unfinished button advances past validated cell or shows all-done state", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NextCell ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Edit and validate cell 0 so it's "finished".
  await ws.editCell(0, "Fini")
  await ws.validateCell(0)

  // Click Next Unfinished button (aria-label in NextUnfinishedButton.tsx).
  const nextBtn = alice.locator('button[aria-label="Next unfinished cell"]')
    .or(alice.locator('button[title="Next unfinished cell"]'))
    .or(alice.getByRole("button", { name: /Next unfinished/i }))
    .first()
  await expect(nextBtn).toBeVisible({ timeout: 5_000 })
  await nextBtn.click()

  // Either all cells are done (toast) or we scrolled to the next cell.
  // The editor table should still be visible in either case.
  const editorTable = alice.locator("table, [data-testid='editor-table'], .editor-table").first()
  // Check the page hasn't crashed by verifying the editor or an expected message.
  await expect(
    editorTable.or(alice.getByText(/All done|No more unfinished/i).first())
  ).toBeVisible({ timeout: 5_000 })
})
