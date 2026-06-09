import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CharacterModal — TTS engine selector buttons.
 *
 * CharacterModal.tsx renders a grid of TTS engine buttons:
 *   - "Gemini" (id: "gemini") — aria-pressed="true" by default
 *   - "MMS"    (id: "mms")
 *   - "Kokoro" (id: "kokoro")
 *
 * Each button has aria-pressed reflecting whether it's the active engine.
 * Clicking a different button switches the engine and updates aria-pressed.
 *
 * This spec: open Audio mode → click "+ New voice" → CharacterModal opens →
 * verify "Gemini" is aria-pressed="true" → click "Kokoro" → "Kokoro" becomes
 * aria-pressed="true" and "Gemini" becomes aria-pressed="false".
 */
test("CharacterModal engine selector switches TTS engine", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EngineSelect ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Switch to Audio mode.
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i })
  await expect(audioBtn).toBeVisible({ timeout: 10_000 })
  await audioBtn.click()
  await expect(audioBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })

  // Click "+ New voice" to open CharacterModal.
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  // CharacterModal opens — "Character name" input is visible.
  await expect(alice.locator('[aria-label="Character name"]')).toBeVisible({ timeout: 5_000 })

  // "Gemini" engine button is aria-pressed="true" (default).
  const geminiBtn = alice.getByRole("button", { name: /^Gemini$/i })
  await expect(geminiBtn).toBeVisible({ timeout: 3_000 })
  await expect(geminiBtn).toHaveAttribute("aria-pressed", "true")

  // Click "Kokoro" — it becomes aria-pressed="true", Gemini becomes "false".
  const kokoroBtn = alice.getByRole("button", { name: /^Kokoro$/i })
  await expect(kokoroBtn).toBeVisible({ timeout: 3_000 })
  await kokoroBtn.click()
  await expect(kokoroBtn).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 })
  await expect(geminiBtn).toHaveAttribute("aria-pressed", "false", { timeout: 2_000 })
})
