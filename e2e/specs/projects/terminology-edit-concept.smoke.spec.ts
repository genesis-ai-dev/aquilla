import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("inline glossary source edit persists in the row", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermEdit ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  const original = `EditMe ${Date.now()}`
  await glossary.addTerm(original, "rendu")
  const updated = `${original} edited`
  const row = await glossary.editSource(original, updated)
  await expect(row).toContainText("rendu")
})
