import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Custom AI provider — selecting "Custom endpoint" reveals endpoint + model inputs.
 *
 * Connect stays enabled; empty endpoint shows a validation error on click.
 */
test("project settings custom provider reveals endpoint and model inputs", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AiCustom ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/?]+)/)?.[1]
  expect(projectId).toBeTruthy()
  // AQU-501: Advanced LLM lives under the AI & completion settings pane.
  await alice.goto(`/project/${projectId}/settings?section=ai`)

  const advancedSummary = alice.getByText("Advanced LLM settings").first()
  await expect(advancedSummary).toBeVisible({ timeout: 10_000 })
  await advancedSummary.click()

  const customRadio = alice.getByRole("radio", { name: /Custom endpoint/i })
  await expect(customRadio).toBeVisible({ timeout: 3_000 })
  await customRadio.click()

  const endpointInput = alice.locator('input[placeholder="http://localhost:8000"]')
  const modelInput = alice.locator("input#mdl-manual")
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })
  await expect(modelInput).toBeVisible({ timeout: 2_000 })

  const connectBtn = alice.getByRole("button", { name: /^Connect$/i })
  await expect(connectBtn).toBeEnabled({ timeout: 2_000 })

  await connectBtn.click()
  await expect(alice.getByText(/endpoint url is required/i)).toBeVisible({ timeout: 2_000 })

  await endpointInput.fill("http://localhost:11434")
  await modelInput.fill("llama3")
  await expect(connectBtn).toBeEnabled({ timeout: 2_000 })
})
