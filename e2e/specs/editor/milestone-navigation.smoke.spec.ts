import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STRUCTURED_MARKDOWN = path.resolve(__dirname, "../../fixtures/milestone-sections.md")

test("structured non-Scripture imports expose searchable milestone navigation", async ({ alice }) => {
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `Milestone nav ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.importFile(STRUCTURED_MARKDOWN)
  await workspace.waitForEditor()

  const currentSection = alice.getByRole("button", {
    name: /Current section: Introduction/,
  })
  await expect(currentSection).toBeVisible()
  await expect(currentSection).toContainText("Introduction")

  await alice.getByRole("button", { name: "Next section" }).click()
  await expect(alice.getByRole("button", {
    name: /Current section: Details/,
  })).toBeVisible()
  await expect(alice.getByText("The detailed workflow begins here.")).toBeVisible()

  await alice.getByRole("button", { name: /Current section: Details/ }).click()
  const search = alice.getByRole("combobox", { name: "Find a section" })
  await search.fill("summary")
  await expect(alice.getByRole("option", { name: /Summary/ })).toBeVisible()
  await expect(alice.getByRole("option", { name: /Introduction/ })).toHaveCount(0)
  await alice.getByRole("option", { name: /Summary/ }).click()

  await expect(alice.getByText("The final section reviews the result.")).toBeVisible()
  await expect(alice.getByRole("button", {
    name: /Current section: Summary/,
  })).toBeVisible()
})
