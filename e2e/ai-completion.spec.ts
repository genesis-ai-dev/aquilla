import { test, expect } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MockLLMServer } from "./mock-llm-server"
import {
  resetAndGotoDashboard,
  createProject,
  openProject,
  importFile,
  waitForEditor,
} from "./helpers"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleFile = path.resolve(__dirname, "fixtures/sample.md")

let mockServer: MockLLMServer

test.beforeAll(async () => {
  mockServer = new MockLLMServer()
  await mockServer.start()
})

test.afterAll(async () => {
  await mockServer.stop()
})

test.beforeEach(async ({ page }) => {
  await resetAndGotoDashboard(page)
})

test("sparkle button fills cell with AI completion", async ({ page }) => {
  // Create and open a project
  const projectName = await createProject(page)
  await openProject(page, projectName)

  // Extract project id from URL (e.g. /project/:id)
  const projectUrl = page.url()
  const projectId = projectUrl.split("/project/")[1]?.split("/")[0] ?? ""
  expect(projectId).toBeTruthy()

  // Navigate to settings
  await page.goto(`/project/${projectId}/settings`)

  // Open Advanced LLM settings
  await page.locator("details").filter({ hasText: "Advanced LLM settings" }).locator("summary").click()

  // Select Custom endpoint radio
  await page.locator("input[name='provider'][type='radio']").last().check()

  // Type mock server URL in endpoint field and blur to save
  const endpointInput = page.locator("#ep")
  await endpointInput.fill(mockServer.baseUrl)
  await endpointInput.blur()

  // Click Connect and wait for Connected
  await page.getByRole("button", { name: "Connect" }).click()
  await expect(page.getByText("Connected")).toBeVisible({ timeout: 10_000 })

  // Navigate back to workspace
  await page.goto(`/project/${projectId}`)
  await expect(page.locator("aside")).toBeVisible({ timeout: 10_000 })

  // Import the sample file
  await importFile(page, sampleFile)

  // Click first file in sidebar
  await page.locator("aside").locator("button, a").filter({ hasText: "sample" }).first().click()

  // Wait for editor to load
  await waitForEditor(page)

  // Click the sparkle button (title contains 'Generate translation')
  const sparkleButton = page.locator("button[title*='Generate translation']").first()
  await expect(sparkleButton).toBeVisible({ timeout: 10_000 })
  await sparkleButton.click()

  // Verify target cell contains the mock response within 15s
  await expect(
    page.locator("[data-cell-id]").first().locator("textarea, .tiptap"),
  ).toContainText("Traducción de prueba", { timeout: 15_000 })
})
