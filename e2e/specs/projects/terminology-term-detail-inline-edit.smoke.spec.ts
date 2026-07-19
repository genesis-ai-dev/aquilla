import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SAMPLE_MD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/sample.md")

test("term detail occurrence opens an inline target editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermDetailEdit ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/editor`)
  await new Workspace(alice).importFile(SAMPLE_MD)

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("sample", "échantillon")
  await glossary.openDetails("sample")
  await expect(alice.getByText(/occurrence/i).first()).toBeVisible({ timeout: 15_000 })

  const editableTarget = alice.getByRole("button", { name: "(empty)" }).first()
  await expect(editableTarget).toBeVisible({ timeout: 5_000 })
  await editableTarget.click()
  const editor = alice.locator('[contenteditable="true"], textarea').first()
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await editor.click()
  await alice.keyboard.type("Traduction test")
  await expect(editor).toContainText("Traduction test")
})
