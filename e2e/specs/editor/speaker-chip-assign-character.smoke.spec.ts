import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SpeakerChip — assign a character to a cell line in audio mode.
 *
 * In audio lens (EditorTable audioLens), each cell row renders a CellVoicePanel
 * which contains a SpeakerChip. The chip:
 *   - Shows "Unassigned" when no voice is assigned.
 *   - Has title="Assign a character to this line".
 *   - Opens a Popover with a flat list of project voices on click.
 *   - Clicking a voice row calls onAssign(voiceId) and the chip updates.
 *
 * This spec:
 *   1. Creates a project, imports sample.md, opens the editor.
 *   2. Switches to audio mode.
 *   3. Creates a voice character "Hero" via CharacterModal.
 *   4. Finds the first SpeakerChip (title="Assign a character to this line").
 *   5. Clicks it → popover opens with "Hero" in the list.
 *   6. Clicks "Hero" → chip now shows "Hero".
 */
test("SpeakerChip assigns a character to a cell line in audio mode", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SpeakerChip ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Translate the first cell — untranslated cells render the "Translate to
  // voice this line" placeholder in audio mode (CellVoicePanel) and never
  // show a SpeakerChip.
  await ws.editCell(0, "Bonjour le monde")

  // Switch to Audio mode.
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i })
  await expect(audioBtn).toBeVisible({ timeout: 5_000 })
  await audioBtn.click()

  // Create a voice character "Hero".
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  const voiceName = "Hero"
  await dialog.locator('input[aria-label="Voice name"]').fill(voiceName)
  await dialog.getByRole("button", { name: /^Create$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(voiceName)).toBeVisible({ timeout: 5_000 })

  // Find the first SpeakerChip in the editor cells.
  const chip = alice.locator('[title="Assign a voice to this line"]').first()
  await expect(chip).toBeVisible({ timeout: 8_000 })
  // An unassigned line resolves to the narrator, so it doesn't show "Hero" yet.
  await expect(chip).not.toContainText(voiceName)
  await chip.click()

  // Popover opens with the voice list. Scope to the popover content — the
  // VoiceLibraryPanel cast-roster row is ALSO a button named "Hero" and
  // precedes the portaled popover in DOM order, so an unscoped .first()
  // would click the library row (opening CharacterModal) instead.
  const heroOption = alice
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: voiceName })
    .first()
  await expect(heroOption).toBeVisible({ timeout: 5_000 })
  await heroOption.click()

  // Chip now shows "Hero".
  await expect(chip).toContainText(voiceName, { timeout: 5_000 })
})
