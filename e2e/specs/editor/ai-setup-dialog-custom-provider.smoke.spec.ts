import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AiSetupDialog → AiProviderStep — "Custom" provider option reveals inputs.
 *
 * AiProviderStep.tsx has two provider toggle buttons: "Frontier" and "Custom".
 * Clicking "Custom" sets selected="custom" and reveals two inputs:
 *   - Endpoint URL: placeholder="http://localhost:8000"
 *   - Model name:   placeholder="gpt-4"
 *
 * This spec: open the AI setup dialog → click "Custom" → verify both
 * inputs appear → fill them in → verify the Save button is enabled.
 */
test("AI setup dialog custom provider reveals endpoint and model inputs", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AiCustom ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click the sparkle button in the cell action rail — aria-label is "Set up AI to enable"
  // when no AI provider is configured (same as ai-setup-dialog.smoke.spec.ts).
  const sparkleBtn = alice.locator('[aria-label="Set up AI to enable"]').first()
  await expect(sparkleBtn).toBeVisible({ timeout: 10_000 })
  await sparkleBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Click the "Custom" provider button.
  const customBtn = dialog.getByRole("button", { name: /Custom/i })
  await expect(customBtn).toBeVisible({ timeout: 3_000 })
  await customBtn.click()

  // Endpoint and model inputs appear.
  const endpointInput = dialog.locator('input[placeholder="http://localhost:8000"]')
  const modelInput = dialog.locator('input[placeholder="gpt-4"]')
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })
  await expect(modelInput).toBeVisible({ timeout: 2_000 })

  // Fill in the endpoint and model.
  await endpointInput.fill("http://localhost:11434")
  await modelInput.fill("llama3")

  // The Save/Connect button should now be enabled (trimmed endpoint is non-empty).
  const saveBtn = dialog.getByRole("button", { name: /Save|Connect|Apply/i }).first()
  await expect(saveBtn).toBeEnabled({ timeout: 2_000 })

  // Dismiss without saving.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
