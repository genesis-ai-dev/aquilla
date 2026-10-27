import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORIGINAL = path.resolve(__dirname, "../../fixtures/sidebar-reimport-v1/genesis.usfm")
const UPDATED = path.resolve(__dirname, "../../fixtures/sidebar-reimport-v2/genesis.usfm")

test("sidebar re-import updates this file and flags the changed source", async ({ alice }) => {
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `Sidebar re-import ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.importFile(ORIGINAL)
  await workspace.openFileBySubstring("genesis")
  await workspace.waitForEditor()

  const index = await workspace.cellIndexBySource("The original source sentence.")
  const translated = `Traduction conservée ${Date.now()}`
  await workspace.editCell(index, translated)
  await workspace.validateCell(index)
  await workspace.sidebarReimportUpdate(UPDATED)

  await alice.reload()
  await workspace.openFileBySubstring("genesis")
  await workspace.waitForEditor()

  const changed = await workspace.cellIndexBySource("The updated source sentence.")
  const changedRow = workspace.cellRow(changed)
  await expect(changedRow.locator('[data-cell-type="target"]')).toContainText(translated)
  await expect(changedRow).toHaveAttribute("data-source-review", "true")
  await changedRow.hover()
  await expect(changedRow.getByRole("button", { name: /Validate|Validated/i }).first())
    .toHaveAttribute("aria-pressed", "false")

  const inserted = await workspace.cellIndexBySource("This verse is new.")
  await expect(workspace.cellRow(inserted).locator('[data-cell-type="target"]')).not.toContainText(translated)
  await expect(workspace.cellRow(inserted)).not.toHaveAttribute("data-source-review", "true")
  await expect(alice.locator("[data-cell-id]")).not.toContainText("This verse will be removed.")
})
