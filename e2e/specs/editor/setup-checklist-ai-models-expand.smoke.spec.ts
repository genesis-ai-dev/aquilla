import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AiModelsStep — "Set up transcription & voice" expand toggle inside
 * the SetupChecklistDrawer.
 *
 * AiModelsStep.tsx starts collapsed: it shows a "Set up transcription & voice"
 * button. Clicking it expands to show a "Transcription" fieldset with the
 * Whisper model checkbox row.
 *
 * This spec: open the setup checklist → expand the "Configure voice &
 * transcription" item → verify the collapsed state → click "Set up
 * transcription & voice" → verify the "Transcription" fieldset legend appears.
 */
test("setup checklist AI models step expand reveals transcription fieldset", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AiModels ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the setup checklist.
  const chip = alice.locator('[title="Open setup checklist"]')
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  await expect(alice.getByRole("heading", { name: /Project setup/i })).toBeVisible({
    timeout: 5_000,
  })

  // Find the "Configure voice & transcription" checklist item and expand it.
  const voiceItem = alice.locator("button[aria-expanded]").filter({
    hasText: /Configure voice/i,
  })
  await expect(voiceItem).toBeVisible({ timeout: 5_000 })

  const isExpanded = await voiceItem.getAttribute("aria-expanded")
  if (isExpanded !== "true") {
    await voiceItem.click()
  }
  await expect(voiceItem).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // AiModelsStep collapsed state: "Set up transcription & voice" button visible.
  const expandBtn = alice.getByText(/Set up transcription & voice/i)
  await expect(expandBtn).toBeVisible({ timeout: 3_000 })

  // The Transcription fieldset should NOT be visible yet.
  await expect(alice.getByText(/^Transcription$/i)).not.toBeVisible({ timeout: 1_000 })

  // Click the expand button.
  await expandBtn.click()

  // Now the "Transcription" legend is visible.
  await expect(alice.getByText(/^Transcription$/i)).toBeVisible({ timeout: 3_000 })

  // The Whisper model name is shown.
  await expect(alice.getByText(/Whisper transcription/i)).toBeVisible({ timeout: 2_000 })
})
