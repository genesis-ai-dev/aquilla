import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Move to corpus dialog — FileActionMenu → Move.
 *
 * MoveToCorpusDialog opens a Dialog with:
 *   - DialogTitle "Move to corpus"
 *   - A <select> with "Ungrouped" and "Other…" options (no existing markers)
 *   - Choosing "Other…" reveals a text input for a custom corpus name
 *   - Cancel closes the dialog without moving
 *
 * This spec verifies the dialog opens, the select works, and Cancel dismisses.
 */
test("move to corpus dialog opens and shows corpus selector", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Move ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Right-click the file row to open the context menu.
  const fileRow = alice.locator("aside").getByText("sample").first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.click({ button: "right" })

  // Click "Move" in the context menu.
  const moveBtn = alice.getByRole("button", { name: /^Move$/i })
  await expect(moveBtn).toBeVisible({ timeout: 3_000 })
  await moveBtn.click()

  // MoveToCorpusDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Move to corpus/i })).toBeVisible()

  // The corpus <select> is present with at least "Ungrouped" option.
  const select = dialog.locator("select")
  await expect(select).toBeVisible()

  // Selecting "Other…" reveals the custom corpus name input.
  await select.selectOption({ label: "Other…" })
  await expect(
    dialog.locator('input[placeholder="New corpus name"]')
  ).toBeVisible({ timeout: 3_000 })

  // Cancel closes without moving.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })

  // File is still in the sidebar (not moved/removed).
  await expect(alice.locator("aside").getByText("sample").first()).toBeVisible({ timeout: 3_000 })
})
