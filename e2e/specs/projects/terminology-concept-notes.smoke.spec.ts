import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary notes save from the expander and appear in term details", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermNotes ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  const sourceTerm = `grace-${Date.now()}`
  const notes = "Used specifically for divine grace, not human kindness."
  await glossary.addTerm(sourceTerm, "grâce")
  await glossary.setNotes(sourceTerm, notes)
  await glossary.openDetails(sourceTerm)
  await expect(alice.getByText(notes)).toBeVisible({ timeout: 8_000 })
})
