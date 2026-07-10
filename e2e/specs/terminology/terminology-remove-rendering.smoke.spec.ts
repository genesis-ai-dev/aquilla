import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("remove rendering keeps the remaining glossary rendering", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `RemoveRend ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("hello", "bonjour")
  const row = await glossary.expandTerm("hello")
  await row.getByRole("button", { name: "Add rendering" }).click()
  const second = row.getByRole("textbox", { name: "Rendering 2 text" })
  await second.fill("salut")
  await second.blur()
  await row.getByRole("button", { name: "Remove rendering 1" }).click()

  await expect(row.getByRole("textbox", { name: "Rendering 1 text" })).toHaveValue("salut")
  await expect(row.getByRole("textbox", { name: "Rendering 2 text" })).not.toBeVisible()
})
