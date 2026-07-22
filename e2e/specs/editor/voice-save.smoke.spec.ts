import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CharacterModal — save a new voice character.
 *
 * CharacterModal has:
 *   - Input aria-label="Character name"
 *   - Save button (type="button")
 *
 * Saving with a name creates the voice and it appears in VoiceLibraryPanel.
 *
 * This spec: open audio mode → click "+ New voice" → fill name →
 * click Save → the new voice appears in the voice list.
 */
test("create a new voice character and it appears in the voice library", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `VoiceSave ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Switch to Audio mode.
  const audioTab = alice.getByRole("tab", { name: /^Audio$/i })
  await expect(audioTab).toHaveAttribute("aria-selected", "false", { timeout: 5_000 })
  await audioTab.click()

  // VoiceSidebar renders "+ New voice".
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  // CharacterModal opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Fill character name.
  const voiceName = `TestVoice ${Date.now()}`
  const nameInput = dialog.locator('input[aria-label="Voice name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(voiceName)

  // Click Create.
  const saveBtn = dialog.getByRole("button", { name: /Create voice/i })
  await expect(saveBtn).toBeVisible({ timeout: 3_000 })
  await saveBtn.click()

  // Dialog closes.
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // The new voice appears in the voice library.
  await expect(alice.getByText(voiceName)).toBeVisible({ timeout: 5_000 })
})
