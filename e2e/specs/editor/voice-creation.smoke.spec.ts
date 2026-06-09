import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Voice creation — "Craft character" dialog.
 *
 * Audio mode (lens === "audio") renders VoiceSidebar with VoiceLibraryPanel.
 * The panel has a "+ New voice" button that opens CharacterModal with
 * h2 "Craft character" and input[aria-label="Character name"].
 *
 * Flow:
 *   1. Import file, open editor.
 *   2. Click the Audio toggle button (EditorModeToggle) to enter audio mode.
 *   3. VoiceSidebar renders with the Cast panel.
 *   4. Click "+ New voice" → CharacterModal opens.
 *   5. Verify "Craft character" heading and character name input.
 *   6. Dismiss via Escape.
 */
test("new voice dialog opens in audio mode with Craft character heading", async ({ alice }) => {
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
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i })
  await expect(audioBtn).toBeVisible({ timeout: 5_000 })
  await audioBtn.click()

  // VoiceSidebar renders when lens === "audio". Wait for "+ New voice".
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  // CharacterModal opens as a Dialog.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // h2 "Craft character"
  await expect(dialog.locator("h2").filter({ hasText: /Craft character/i })).toBeVisible()

  // Character name input
  await expect(dialog.locator('input[aria-label="Character name"]')).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
