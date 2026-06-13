import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Custom AI provider — selecting "Custom endpoint" reveals endpoint + model inputs.
 *
 * Originally this spec drove AiSetupDialog → AiProviderStep from the cell
 * sparkle button's "Set up AI to enable" state. Since 06b494104 ("Frontier
 * default"), signed-in users are always configured (Frontier fallback), so
 * that dialog is unreachable through the UI. The custom-provider form now
 * lives in Project Settings → "Advanced LLM settings" (ProjectSettings.tsx):
 *   - Provider radio group: "Frontier" / "Custom endpoint"
 *   - Choosing Custom reveals:
 *       Endpoint URL input (#ep, placeholder "http://localhost:8000") with a
 *       "Connect" button (disabled until the endpoint is non-empty), and a
 *       manual model input (#mdl-manual) when no models were discovered.
 *
 * This spec: open project settings → expand Advanced LLM settings → select
 * "Custom endpoint" → verify both inputs appear → fill them → verify the
 * Connect button becomes enabled. (We don't click Connect/Save — no real
 * endpoint exists in the harness.)
 */
test("project settings custom provider reveals endpoint and model inputs", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AiCustom ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Workspace URL is /project/:id — derive the id and go to settings.
  const projectId = alice.url().match(/\/project\/([^/?]+)/)?.[1]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/settings`)

  // Expand the collapsed "Advanced LLM settings" <details> section.
  const advancedSummary = alice.getByText("Advanced LLM settings").first()
  await expect(advancedSummary).toBeVisible({ timeout: 10_000 })
  await advancedSummary.click()

  // Select the "Custom endpoint" provider radio.
  const customRadio = alice.getByRole("radio", { name: /Custom endpoint/i })
  await expect(customRadio).toBeVisible({ timeout: 3_000 })
  await customRadio.click()

  // Endpoint and model inputs appear.
  const endpointInput = alice.locator('input[placeholder="http://localhost:8000"]')
  const modelInput = alice.locator("input#mdl-manual")
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })
  await expect(modelInput).toBeVisible({ timeout: 2_000 })

  // Connect is gated on a non-empty endpoint.
  const connectBtn = alice.getByRole("button", { name: /^Connect$/i })
  await expect(connectBtn).toBeDisabled({ timeout: 2_000 })

  // Fill in the endpoint and model.
  await endpointInput.fill("http://localhost:11434")
  await modelInput.fill("llama3")

  // The Connect button is now enabled (trimmed endpoint is non-empty).
  await expect(connectBtn).toBeEnabled({ timeout: 2_000 })
})
