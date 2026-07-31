import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Voice picker — choosing a cast voice assigns + voices a line in audio mode.
 *
 * In audio lens (EditorTable audioLens), each translated cell renders a
 * CellVoicePanel with a compact cast combobox. Picking a voice assigns the
 * line to that voice and kicks off generation immediately.
 *
 * This spec:
 *   1. Creates a project, imports sample.md, opens the editor.
 *   2. Switches to audio mode.
 *   3. Creates a voice "Hero" via the New voice modal.
 *   4. Opens the first cell's voice chooser.
 *   5. Chooses Hero → the trigger updates to Hero.
 */
test("clicking a voice chip assigns a line to that voice in audio mode", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `SpeakerChip ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Translate the first cell — untranslated cells render the "Translate to
  // voice this line" placeholder in audio mode (CellVoicePanel) and never
  // show the cast chip strip.
  await ws.editCell(0, "Bonjour le monde")

  // Switch to Audio mode.
  const audioTab = alice.getByRole("tab", { name: /^Audio$/i })
  await expect(audioTab).toBeVisible({ timeout: 5_000 })
  await audioTab.click()

  // Create a voice character "Hero".
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  const voiceName = "Hero"
  await dialog.locator('input[aria-label="Voice name"]').fill(voiceName)
  await dialog.getByRole("button", { name: /Create voice/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(voiceName)).toBeVisible({ timeout: 5_000 })

  // The voice column shows a compact cast combobox. Scope to the editor (main)
  // so we don't match the identically-named row in the Voices dock panel.
  const voiceTrigger = alice
    .getByRole("main")
    .getByRole("button", { name: /Voice:.*Choose a voice/i })
    .first()
  await expect(voiceTrigger).toBeVisible({ timeout: 8_000 })
  await expect(voiceTrigger).toHaveAttribute("aria-label", /Voice: Narrator\. Choose a voice/i)

  // Choosing Hero assigns this line to Hero (and kicks off generation).
  await voiceTrigger.click()
  const heroOption = alice
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: voiceName, exact: true })
  await expect(heroOption).toBeVisible({ timeout: 5_000 })
  await heroOption.click()
  await expect(voiceTrigger).toHaveAttribute("aria-label", /Voice: Hero\. Choose a voice/i, {
    timeout: 5_000,
  })
})
