import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTURE_SHEET = path.resolve(__dirname, "../../fixtures/scripture-mapping.csv")

test("Upload files maps spreadsheet structure before importing", async ({ alice }) => {
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `Spreadsheet import ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.previewMappedSpreadsheet(SCRIPTURE_SHEET)

  await expect(alice.getByLabel("Structural content")).toContainText("—")
  await expect(alice.getByText("GEN 1:1", { exact: true })).toBeVisible()
  await expect(alice.getByText("In the beginning", { exact: true })).toBeVisible()

  await workspace.confirmImportPreview()
  await workspace.openFileBySubstring("scripture-mapping")
  await workspace.waitForEditor()
  await expect(alice.getByRole("button", { name: "Expand" })).toBeVisible()
  await expect(alice.getByRole("button", { name: "Current chapter: Genesis 1. Choose chapter" })).toBeVisible()
  await expect(workspace.cellRow(0)).toContainText("Creation")
  await expect(workspace.cellRow(1)).toContainText("In the beginning")
  await expect(workspace.cellRow(1).locator('[data-cell-type="target"]')).toContainText("Au commencement")
})
