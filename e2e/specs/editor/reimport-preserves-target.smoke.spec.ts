import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORIGINAL = path.resolve(__dirname, "../../fixtures/reimport-v1/reimport.md")
const UPDATED = path.resolve(__dirname, "../../fixtures/reimport-v2/reimport.md")

test("re-import updates stable source units without replacing their targets", async ({ alice }) => {
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `Safe re-import ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.importFile(ORIGINAL)
  await workspace.openFileBySubstring("reimport")
  await workspace.waitForEditor()

  const translated = `Traduction conservée ${Date.now()}`
  await workspace.editCell(1, translated)
  await workspace.reimportFile(UPDATED)

  await alice.reload()
  await workspace.openFileBySubstring("reimport")
  await workspace.waitForEditor()
  await expect(workspace.cellRow(1).locator('[data-cell-type="source"]'))
    .toContainText("The updated source paragraph.")
  await expect(workspace.cellRow(1).locator('[data-cell-type="target"]'))
    .toContainText(translated)
  await expect(alice.locator("aside").getByText(/reimport\.md/i)).toHaveCount(1)
})
