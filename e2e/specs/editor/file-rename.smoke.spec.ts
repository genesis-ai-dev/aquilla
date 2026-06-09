import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * File rename via the FileActionMenu (context menu).
 *
 * FileRow right-click → FileActionMenu with "Rename" button →
 * FileRow switches to an inline input → Enter commits the new name →
 * the sidebar shows the updated name.
 *
 * Architecture note (MEMORY.md): file renames emit a file.rename event
 * and are synced to the server via sync-worker. The sidebar reflects
 * the new name immediately through the optimistic overlay.
 */
test("file rename via context menu updates sidebar name", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Rename ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // The file row is in the sidebar (aside). Right-click to open context menu.
  const fileRow = alice.locator("aside").getByText("sample").first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.click({ button: "right" })

  // FileActionMenu appears — click "Rename".
  const renameBtn = alice.getByRole("button", { name: /^Rename$/i })
  await expect(renameBtn).toBeVisible({ timeout: 3_000 })
  await renameBtn.click()

  // FileRow switches to inline input. Fill new name and press Enter.
  const renameInput = alice.locator("aside input").first()
  await expect(renameInput).toBeVisible({ timeout: 3_000 })
  const newFileName = "renamed-sample"
  await renameInput.fill(newFileName)
  await renameInput.press("Enter")

  // The sidebar should now show the new file name.
  await expect(alice.locator("aside").getByText(newFileName).first()).toBeVisible({
    timeout: 5_000,
  })
})
