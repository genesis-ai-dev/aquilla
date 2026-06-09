import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * FileRow — "File actions" button opens the file context menu.
 *
 * FileRow.tsx has a MoreHorizontal (⋯) button with aria-label="File actions"
 * that appears on hover inside the sidebar file list. Clicking it calls
 * onOpenMenu(x, y) which opens the FileActionMenu popup.
 *
 * The context menu contains items like "Rename", "Move", "Delete".
 *
 * This spec: import a file → hover the file row → click "File actions" →
 * verify the context menu contains "Rename" and "Delete" items.
 */
test("file actions button opens context menu with Rename and Delete", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `FileActions ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Wait for the file row to appear in the sidebar.
  const fileRow = alice.locator("aside").getByText(/sample/i).first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })

  // Hover over the file row to reveal the "File actions" button.
  await fileRow.hover()

  // Click the "File actions" (MoreHorizontal) button.
  const fileActionsBtn = alice.locator('[aria-label="File actions"]')
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })
  await fileActionsBtn.click()

  // The context menu popup should appear with Rename and Delete items.
  const renameItem = alice.getByRole("button", { name: /^Rename$/i })
    .or(alice.getByRole("menuitem", { name: /Rename/i }))
  await expect(renameItem).toBeVisible({ timeout: 5_000 })

  const deleteItem = alice.getByRole("button", { name: /^Delete$/i })
    .or(alice.getByRole("menuitem", { name: /Delete/i }))
  await expect(deleteItem).toBeVisible({ timeout: 3_000 })

  // Press Escape to dismiss the menu.
  await alice.keyboard.press("Escape")
  await expect(renameItem).not.toBeVisible({ timeout: 3_000 })
})
