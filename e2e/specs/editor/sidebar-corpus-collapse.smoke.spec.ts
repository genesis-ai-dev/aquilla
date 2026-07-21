import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")
const CHAPTER_1_MD = path.resolve(__dirname, "../../fixtures/chapter-1.md")

/**
 * ExpandableFileList — corpus group collapse/expand.
 *
 * When files belong to two or more corpus groups, each group header shows
 * a toggle button (aria-label "Collapse <group>" / "Expand <group>").
 * Clicking the toggle collapses the group (files hidden) or expands it.
 *
 * Setup to create two groups:
 *   1. Import two files (both land in "Ungrouped").
 *   2. Move one file to a named corpus "TestCorpus" via the context-menu
 *      Move dialog (select "Other…" → type name → click Save).
 *   3. Now two corpus groups exist.
 *
 * The Collapse button only appears on the group header for non-Ungrouped
 * groups (aria-label "Collapse TestCorpus"). Clicking it collapses that
 * section; clicking again expands it.
 */
test("sidebar corpus group collapses and expands", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CorpusCollapse ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  // Import two distinctly-named files. Re-importing the same name now hits
  // the AQU-287 collision screen (defaults to "skip"), so a second copy of
  // sample.md would never land — use a different fixture instead.
  await ws.importFile(SAMPLE_MD)
  await ws.importFile(CHAPTER_1_MD)

  // Wait for at least two files visible in the sidebar.
  await expect(alice.locator("aside").getByText(/sample/i).first()).toBeVisible({
    timeout: 10_000,
  })

  // Right-click the first "sample" file to open the context menu.
  const firstFileRow = alice.locator("aside").getByText(/sample/i).first()
  await firstFileRow.click({ button: "right" })

  // Click "Move to corpus…" (shadcn ContextMenu — role="menuitem").
  const moveBtn = alice.getByRole("menuitem", { name: /Move to corpus/i })
  await expect(moveBtn).toBeVisible({ timeout: 3_000 })
  await moveBtn.click()

  // MoveToCorpusDialog — select "Other…" to enter a custom corpus name.
  const dialog = alice.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: /Move to corpus/i })).toBeVisible({
    timeout: 5_000,
  })
  const select = dialog.locator("select")
  await select.selectOption({ label: "Other…" })

  const corpusNameInput = dialog.locator('input[placeholder="New corpus name"]')
  await expect(corpusNameInput).toBeVisible({ timeout: 3_000 })
  await corpusNameInput.fill("TestCorpus")

  // Confirm the move — MoveToCorpusDialog's confirm button is labelled "Save".
  const moveConfirmBtn = dialog.getByRole("button", { name: /^Save$/i })
  await expect(moveConfirmBtn).toBeEnabled({ timeout: 2_000 })
  await moveConfirmBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Now two corpus groups exist. The "TestCorpus" group header should be visible
  // with a Collapse toggle button.
  const collapseBtn = alice.locator("aside").getByRole("button", {
    name: /Collapse TestCorpus/i,
  })
  await expect(collapseBtn).toBeVisible({ timeout: 10_000 })

  // Collapse the group.
  await collapseBtn.click()

  // The aria-label should change to "Expand TestCorpus".
  const expandBtn = alice.locator("aside").getByRole("button", {
    name: /Expand TestCorpus/i,
  })
  await expect(expandBtn).toBeVisible({ timeout: 3_000 })

  // Expand again.
  await expandBtn.click()
  await expect(
    alice.locator("aside").getByRole("button", { name: /Collapse TestCorpus/i })
  ).toBeVisible({ timeout: 3_000 })
})
