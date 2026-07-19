import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Gemini API key — reveal/conceal toggle.
 *
 * The per-voice engine refactor removed the project-level "Gemini API key"
 * collapsible from VoiceLibraryPanel; the key now lives in Project Settings
 * (Voice section) as an ApiKeyField:
 *   - <Input type="password" placeholder="AIza..."> (masked by default)
 *   - an eye Button toggling aria-label "Show key" / "Hide key", which flips
 *     the input between type="password" and type="text".
 *
 * This spec: open Project Settings → find the Gemini key field in the Voice
 * section (masked) → click "Show key" → input becomes text → click
 * "Hide key" → masked again.
 */
test("project settings Gemini API key field reveals and conceals the key", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `GeminiKey ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Creation lands on the project Overview (/projects/:id) — grab the id.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // AQU-501: Voice lives under the AI & completion settings pane.
  await alice.goto(`/project/${projectId}/settings/ai`)
  await alice.waitForLoadState("networkidle")

  // Scope to the Voice settings card — other sections render their own
  // ApiKeyFields with the same Show/Hide buttons.
  const voiceSection = alice.locator("#section-voice")
  await expect(voiceSection).toBeVisible({ timeout: 10_000 })

  const keyInput = voiceSection.locator('input[placeholder="AIza..."]')
  await expect(keyInput).toBeVisible({ timeout: 5_000 })
  // Masked by default.
  await expect(keyInput).toHaveAttribute("type", "password")

  // Reveal.
  await voiceSection.getByRole("button", { name: /^Show key$/i }).click()
  await expect(keyInput).toHaveAttribute("type", "text", { timeout: 3_000 })

  // Conceal again.
  await voiceSection.getByRole("button", { name: /^Hide key$/i }).click()
  await expect(keyInput).toHaveAttribute("type", "password", { timeout: 3_000 })
})
