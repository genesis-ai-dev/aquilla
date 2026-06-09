import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * VoiceLibraryPanel — "Gemini API key" collapsible toggle.
 *
 * VoiceLibraryPanel.tsx renders a collapsible "Gemini API key" row
 * (button with KeyRound icon + text "Gemini API key"). Clicking it
 * sets `keyOpen=true` which expands an ApiKeyField with a placeholder
 * "AIza...". Clicking again collapses it.
 *
 * This spec: open Audio mode → click "Gemini API key" → verify the
 * API key input appears (placeholder "AIza...") → click again →
 * verify the input collapses.
 */
test("voice library Gemini API key row expands and collapses", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `GeminiKey ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Switch to Audio mode.
  const audioBtn = alice.locator('button[aria-pressed="false"]').filter({ hasText: /^Audio$/i })
    .or(alice.getByRole("button", { name: /^Audio$/i }).first())
  await expect(audioBtn.first()).toBeVisible({ timeout: 10_000 })
  await audioBtn.first().click()

  // The VoiceLibraryPanel renders with the "Gemini API key" collapsible button.
  const geminiKeyBtn = alice.getByRole("button", { name: /Gemini API key/i })
  await expect(geminiKeyBtn).toBeVisible({ timeout: 10_000 })

  // The API key input should not be visible before clicking.
  const keyInput = alice.locator('input[placeholder="AIza..."]')
  await expect(keyInput).not.toBeVisible({ timeout: 2_000 })

  // Click to expand.
  await geminiKeyBtn.click()
  await expect(keyInput).toBeVisible({ timeout: 3_000 })

  // Click again to collapse.
  await geminiKeyBtn.click()
  await expect(keyInput).not.toBeVisible({ timeout: 2_000 })
})
