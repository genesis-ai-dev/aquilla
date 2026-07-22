import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UNKNOWN_RECORDS = path.resolve(__dirname, "../../fixtures/legacy-scripture.records")

test("unknown structured text is AI-classified, reviewed, and imported into the active target lane", async ({ alice }) => {
  test.setTimeout(45_000)
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `AI import ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.previewImportFile(UNKNOWN_RECORDS)

  const classification = alice.getByTestId("ai-import-classification")
  await expect(classification).toContainText("scripture")
  await expect(classification).toContainText("98% confidence")
  await expect(classification).toContainText("Pipe-delimited Scripture records")
  await expect(alice.getByLabel("Structural content")).toContainText("—")

  await workspace.confirmImportPreview()
  await workspace.openFileBySubstring("legacy-scripture")
  await workspace.waitForEditor()

  await expect(workspace.cellRow(0)).toContainText("The Beginning")
  await expect(workspace.cellRow(0).locator('[data-cell-type="target"]')).toContainText("Le commencement", { timeout: 15_000 })
  await expect(workspace.cellRow(1)).toContainText("In the beginning God created")
  await expect(workspace.cellRow(1).locator('[data-cell-type="target"]')).toContainText("Au commencement", { timeout: 15_000 })
})
