import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * File rename via the FileActionMenu (context menu).
 *
 * FileRow right-click → FileActionMenu with "Rename" menu item →
 * FileRow switches to an inline input → Enter commits the new name →
 * the sidebar shows the updated name.
 *
 * Architecture note (MEMORY.md): file renames emit a file.rename event
 * and are synced to the server via sync-worker. The sidebar reflects
 * the new name immediately through the optimistic overlay.
 */
test("file rename via context menu updates sidebar name", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Rename ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The file row is in the sidebar (aside). Right-click to open context menu.
  const fileRow = alice.locator("aside").getByText("sample").first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.click({ button: "right" })

  // FileActionMenu appears (shadcn ContextMenu) — click "Rename".
  const renameItem = alice.getByRole("menuitem", { name: /^Rename$/i })
  await expect(renameItem).toBeVisible({ timeout: 3_000 })
  await renameItem.click()

  // FileRow switches to inline input. The sidebar's filter input is a
  // role=searchbox, so role=textbox uniquely matches the rename input.
  const renameInput = alice.locator("aside").getByRole("textbox")
  await expect(renameInput).toBeVisible({ timeout: 3_000 })
  const newFileName = "renamed-sample"
  await renameInput.fill(newFileName)
  await renameInput.press("Enter")

  // The sidebar should now show the new file name.
  await expect(alice.locator("aside").getByText(newFileName).first()).toBeVisible({
    timeout: 5_000,
  })
})
