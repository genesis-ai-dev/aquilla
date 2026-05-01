import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("sparkle button fills target cell from mock LLM", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AI ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "es" })
  await dash.openProject(name)

  // Configure the project to use the local mock LLM via Settings page
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/settings`)
  await alice.locator("details").filter({ hasText: "Advanced LLM settings" }).locator("summary").click()
  // Select the "Custom" provider radio (last one in the list)
  await alice.locator("input[name='provider'][type='radio']").last().check()
  const endpointInput = alice.locator("#ep")
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await endpointInput.fill(llmBase)
  await endpointInput.blur()
  await alice.getByRole("button", { name: "Connect" }).click()
  await expect(alice.getByText("Connected")).toBeVisible({ timeout: 10_000 })

  // Back to workspace, import, complete
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await alice.locator("button[title*='Generate translation']").first().click()

  // MockLLMServer's default response is "Traducción de prueba"
  await expect(
    alice.locator("[data-cell-id]").first().locator("textarea, .tiptap"),
  ).toContainText("Traducción de prueba", { timeout: 15_000 })
})
