import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Voice creation — unified "New voice" modal.
 *
 * Audio mode (lens === "audio") renders VoiceSidebar with VoiceLibraryPanel.
 * The panel has a single "New voice" button that opens NewVoiceModal (TTS /
 * Clone tabs) with h2 "New voice", input[aria-label="Voice name"], and the
 * 4-engine picker (OmniVoice / Gemini / Kokoro / MMS) on the TTS tab.
 *
 * Flow:
 *   1. Import file, open editor.
 *   2. Click the Audio toggle button (EditorModeToggle) to enter audio mode.
 *   3. VoiceSidebar renders with the Voices panel.
 *   4. Click "New voice" → NewVoiceModal opens.
 *   5. Verify "New voice" heading, Voice name input, and the engine picker.
 *   6. Dismiss via Escape.
 */
test("new voice dialog opens in audio mode with New voice heading", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Voice ${Date.now()}` })
  await openSeededProject(alice, seeded)

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

  // Engine picker offers all four TTS engines (regression: creation used to
  // hardcode Gemini, stranding Kokoro/MMS/OmniVoice projects).
  for (const engine of [/OmniVoice/, /Gemini/, /Kokoro/, /MMS/]) {
    await expect(dialog.getByRole("button", { name: engine })).toBeVisible()
  }

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
