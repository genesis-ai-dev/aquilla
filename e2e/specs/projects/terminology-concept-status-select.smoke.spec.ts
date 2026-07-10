import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary lifecycle archives and restores an active term", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermStatus ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("covenant", "alliance")
  await glossary.archiveTerm("covenant")
  await glossary.showArchived()
  await expect(glossary.row("covenant")).toHaveAttribute("data-status", "deprecated")
  await glossary.restoreTerm("covenant")
})
