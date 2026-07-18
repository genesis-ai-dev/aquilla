import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("Close detail dismisses the glossary term detail surface", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermClose ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("hello", "bonjour")
  await glossary.openDetails("hello")

  const close = alice.getByRole("button", { name: "Close detail" })
  await close.click()
  await expect(close).not.toBeVisible()
  await expect(glossary.row("hello")).toBeVisible()
})
