import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("append row saves an active glossary term", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `Terms ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  const sourceTerm = `spirit-${Date.now()}`
  const row = await glossary.addTerm(sourceTerm, "esprit")
  await expect(row).toContainText("esprit")
  await expect(row).toHaveAttribute("data-status", "active")
})
