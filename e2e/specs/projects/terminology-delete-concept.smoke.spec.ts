import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("archiving a glossary term removes it from the active list without deleting it", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermArchive ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  const term = `Archive ${Date.now()}`
  await glossary.addTerm(term, "archivé")
  await glossary.archiveTerm(term)

  await expect(alice.getByRole("button", { name: /Show archived \(1\)/ })).toBeVisible()
  await glossary.showArchived()
  await expect(glossary.row(term)).toHaveAttribute("data-status", "deprecated")
})
