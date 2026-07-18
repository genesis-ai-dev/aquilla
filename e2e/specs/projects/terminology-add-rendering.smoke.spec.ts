import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary row expander adds and removes a rendering", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermRendering ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("spirit", "esprit")
  const row = await glossary.expandTerm("spirit")

  await expect(row.getByRole("textbox", { name: "Rendering 1 text" })).toHaveValue("esprit")
  await row.getByRole("button", { name: "Add rendering" }).click()
  const second = row.getByRole("textbox", { name: "Rendering 2 text" })
  await expect(second).toBeVisible()
  await second.fill("âme")
  await second.blur()
  await row.getByRole("button", { name: "Remove rendering 2" }).click()
  await expect(second).not.toBeVisible()
  await expect(row.getByRole("textbox", { name: "Rendering 1 text" })).toHaveValue("esprit")
})
