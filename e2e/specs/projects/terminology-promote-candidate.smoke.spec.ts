import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SAMPLE_MD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/sample.md")

test("accepting a suggested term promotes its inline row to active", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermPromote ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/editor`)
  await new Workspace(alice).importFile(SAMPLE_MD)
  await new Glossary(alice).goto(projectId!)
  await alice.getByRole("button", { name: "Suggest terms" }).click()

  const pending = alice.locator('[data-testid="glossary-row"][data-status="draft"]').first()
  await expect(pending).toBeVisible({ timeout: 15_000 })
  const conceptId = await pending.getAttribute("data-concept-id")
  expect(conceptId).toBeTruthy()
  const concept = alice.locator(`[data-testid="glossary-row"][data-concept-id="${conceptId}"]`)
  await pending.getByRole("button", { name: "Accept term" }).click()
  await expect(concept).toHaveAttribute("data-status", "active", { timeout: 8_000 })
})
