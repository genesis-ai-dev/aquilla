import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { pickSelectOption } from "../../helpers/base-ui"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")
const CHAPTER_1_MD = path.resolve(__dirname, "../../fixtures/chapter-1.md")

/**
 * ExpandableFileList — rename corpus group inline.
 *
 * Each named corpus group header has a pencil icon button with
 *   aria-label="Rename <group>"
 * visible on hover. Clicking it transforms the group label into an
 * inline <input> (autoFocus). Typing a new name and pressing Enter
 * (or blurring) commits the rename — the sidebar label updates.
 *
 * Setup:
 *   1. Import two files so there are at least two items in the sidebar.
 *   2. Move one to a named corpus "OldName" via the Move dialog.
 *   3. Hover over the "OldName" group header to reveal the Rename button.
 *   4. Click it → inline input appears.
 *   5. Clear the input, type "NewName", press Enter.
 *   6. Verify the group label shows "NewName".
 */
test("sidebar corpus group can be renamed inline", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `CorpusRename ${Date.now()}`
  await dash.createProject({ name: projName, source: "en", target: "fr" })
  await dash.openProject(projName)

  const ws = new Workspace(alice)
  // Import two distinctly-named files. Re-importing the same name now hits
  // the AQU-287 collision screen (defaults to "skip"), so a second copy of
  // sample.md would never land — use a different fixture instead.
  await ws.importFile(SAMPLE_MD)
  await ws.importFile(CHAPTER_1_MD)

  // Wait for files in sidebar.
  await expect(alice.locator("aside").getByText(/sample/i).first()).toBeVisible({
    timeout: 10_000,
  })

  // Move the first file to a new corpus called "OldName".
  const firstFileRow = alice.locator("aside").getByText(/sample/i).first()
  await firstFileRow.click({ button: "right" })

  // "Move to corpus…" in the context menu (shadcn DropdownMenu — role="menuitem").
  const moveBtn = alice.getByRole("menuitem", { name: /Move to corpus/i })
  await expect(moveBtn).toBeVisible({ timeout: 3_000 })
  await moveBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: /Move to corpus/i })).toBeVisible({
    timeout: 5_000,
  })
  const select = dialog.getByRole("combobox", { name: /Corpus/i })
  await pickSelectOption(alice, select, "Create a corpus")

  const corpusNameInput = dialog.getByPlaceholder("Corpus name")
  await expect(corpusNameInput).toBeVisible({ timeout: 3_000 })
  await corpusNameInput.fill("OldName")

  // MoveToCorpusDialog's confirm button is labelled "Save".
  const moveConfirmBtn = dialog.getByRole("button", { name: /^Save$/i })
  await expect(moveConfirmBtn).toBeEnabled({ timeout: 2_000 })
  await moveConfirmBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // "OldName" corpus group header should now be visible.
  const corpusHeader = alice.locator("aside").getByText("OldName").first()
  await expect(corpusHeader).toBeVisible({ timeout: 10_000 })

  // Hover over the corpus header area to reveal the Rename button.
  const renameBtn = alice.locator('[aria-label="Rename OldName"]')
  await corpusHeader.hover()
  await expect(renameBtn).toBeVisible({ timeout: 5_000 })

  // Click the rename button — inline input appears.
  await renameBtn.click()

  // The inline input is autoFocused. Clear + type new name + press Enter.
  // NOTE: the sidebar's filter input has role="searchbox", so the inline
  // rename input is the only role="textbox" inside the aside — `aside input`
  // would match the filter first.
  const inlineInput = alice.locator("aside").getByRole("textbox")
  await expect(inlineInput).toBeVisible({ timeout: 3_000 })
  await inlineInput.selectText()
  await inlineInput.fill("NewName")
  await inlineInput.press("Enter")

  // Group label should update to "NewName".
  await expect(alice.locator("aside").getByText("NewName").first()).toBeVisible({
    timeout: 5_000,
  })
  // "OldName" should no longer be visible as a group label.
  await expect(alice.locator("aside").getByText("OldName")).not.toBeVisible({ timeout: 3_000 })
})
