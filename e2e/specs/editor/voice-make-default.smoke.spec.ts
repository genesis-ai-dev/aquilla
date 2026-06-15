import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MakeDefault ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Switch to Audio mode.
  const audioBtn = alice
    .locator('button[aria-pressed="false"]')
    .filter({ hasText: /Audio/i })
  await expect(audioBtn.first()).toBeVisible({ timeout: 5_000 })
  await audioBtn.first().click()

  // Create a new voice.
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const voiceName = `DefaultVoice ${Date.now()}`
  await dialog.locator('input[aria-label="Voice name"]').fill(voiceName)
  await dialog.getByRole("button", { name: /^Create$/i }).click()

  // Dialog closes, voice appears in the selector list as a row.
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  const voiceRow = alice.locator('div[role="button"]').filter({ hasText: voiceName })
  await expect(voiceRow).toBeVisible({ timeout: 5_000 })

  // A fresh voice is not the narrator yet.
  await expect(voiceRow.getByTitle(/lines without an explicit speaker/i)).toHaveCount(0)

  // Open the row's ⋯ menu and set it as narrator.
  await voiceRow.getByRole("button", { name: /More voice actions/i }).click({ force: true })
  await alice.getByRole("button", { name: /Set as narrator/i }).click()

  // The row now carries the narrator badge.
  await expect(voiceRow.getByTitle(/lines without an explicit speaker/i)).toBeVisible({ timeout: 3_000 })
})
