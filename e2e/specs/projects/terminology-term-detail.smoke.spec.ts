import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary row opens term details and close returns to the list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermDetail ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  const term = `forage-${Date.now()}`
  await glossary.addTerm(term, "fourrage")
  await glossary.openDetails(term)
  await expect(alice.getByText(term).first()).toBeVisible()

  await alice.getByRole("button", { name: "Close detail" }).click()
  await expect(glossary.row(term)).toBeVisible({ timeout: 5_000 })
})
