import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary renders its editor-style append surface", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `Glossary ${Date.now()}`, source: "en", target: "fr" })

  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await new Glossary(alice).goto(projectId!)
  await expect(alice.getByText("Source", { exact: true })).toBeVisible()
  await expect(alice.getByText("Rendering", { exact: true })).toBeVisible()
  await expect(alice.getByPlaceholder("New source term…")).toBeVisible()
  await expect(alice.getByPlaceholder("rendering", { exact: true })).toBeVisible()
  await expect(alice.getByRole("button", { name: "Add term" })).toBeDisabled()
})
