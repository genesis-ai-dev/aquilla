import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VoiceSave ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Switch to Audio mode.
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i }).filter({ hasNot: alice.locator('[aria-pressed="true"]') })
    .or(alice.locator('button[aria-pressed="false"]').filter({ hasText: /Audio/i }))
  await expect(audioBtn.first()).toBeVisible({ timeout: 5_000 })
  await audioBtn.first().click()

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
  const saveBtn = dialog.getByRole("button", { name: /^Create$/i })
  await expect(saveBtn).toBeVisible({ timeout: 3_000 })
  await saveBtn.click()

  // Dialog closes.
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // The new voice appears in the voice library.
  await expect(alice.getByText(voiceName)).toBeVisible({ timeout: 5_000 })
})
