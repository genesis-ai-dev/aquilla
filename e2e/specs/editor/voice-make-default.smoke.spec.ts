import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CharacterModal — "Make narrator" button.
 *
 * VoiceLibraryPanel shows a voice row for each character. Clicking a row
 * opens CharacterModal in edit mode, which shows a "Make narrator" button
 * in the footer (when the voice is not already the narrator/default).
 *
 * This spec: create a voice → click its row to open CharacterModal in edit
 * mode → verify "Make narrator" button is visible → click it → verify the
 * "Narrator (default)" badge replaces the button.
 *
 * Note: the button was previously named "Make default" and the badge was
 * "Default character". Both were renamed to "Make narrator" / "Narrator (default)"
 * to better communicate the narrator role in multi-voice projects.
 */
test("CharacterModal Make narrator sets the voice as narrator/default", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `MakeDefault ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Switch to Audio mode.
  const audioTab = alice.getByRole("tab", { name: /Audio|Media/i }).first()
  await expect(audioTab).toBeVisible({ timeout: 5_000 })
  await audioTab.click()

  // Create a new voice.
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const voiceName = `DefaultVoice ${Date.now()}`
  await dialog.locator('input[aria-label="Voice name"]').fill(voiceName)
  await dialog.getByRole("button", { name: /Create voice/i }).click()

  // Dialog closes, voice appears in the selector list as a row.
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  const voiceRow = alice.locator('div[role="button"]').filter({ hasText: voiceName })
  await expect(voiceRow).toBeVisible({ timeout: 5_000 })

  // A fresh voice is not the narrator yet.
  await expect(voiceRow.getByText("Narrator", { exact: true })).toHaveCount(0)

  // Open the row's ⋯ menu and set it as narrator.
  await voiceRow.getByRole("button", { name: /More voice actions/i }).click({ force: true })
  await alice.getByRole("button", { name: /Set as narrator/i }).click()

  // The row now carries the Narrator badge (tooltip via AppTooltip, not title).
  await expect(voiceRow.getByText("Narrator", { exact: true })).toBeVisible({ timeout: 3_000 })
})
