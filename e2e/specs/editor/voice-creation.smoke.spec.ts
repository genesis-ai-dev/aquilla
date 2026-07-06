import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Voice creation — unified "New voice" modal.
 *
 * Audio mode (lens === "audio") renders VoiceSidebar with VoiceLibraryPanel.
 * The panel has a single "New voice" button that opens NewVoiceModal (Gemini /
 * Clone tabs) with h2 "New voice" and input[aria-label="Voice name"].
 *
 * Flow:
 *   1. Import file, open editor.
 *   2. Click the Audio toggle button (EditorModeToggle) to enter audio mode.
 *   3. VoiceSidebar renders with the Voices panel.
 *   4. Click "New voice" → NewVoiceModal opens.
 *   5. Verify "New voice" heading and Voice name input.
 *   6. Dismiss via Escape.
 */
test("new voice dialog opens in audio mode with New voice heading", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Voice ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Switch to audio mode via the EditorModeToggle.
  const audioTab = alice.getByRole("tab", { name: /^Audio$/i })
  await expect(audioTab).toBeVisible({ timeout: 5_000 })
  await audioTab.click()

  // VoiceSidebar renders when lens === "audio". Wait for "+ New voice".
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  // NewVoiceModal opens as a Dialog.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // h2 "New voice"
  await expect(dialog.locator("h2").filter({ hasText: /New voice/i })).toBeVisible()

  // Voice name input
  await expect(dialog.locator('input[aria-label="Voice name"]')).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
