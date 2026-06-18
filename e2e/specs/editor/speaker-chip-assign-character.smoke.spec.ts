import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Voice chip — clicking a cast chip assigns + voices a line in audio mode.
 *
 * In audio lens (EditorTable audioLens), each translated cell renders a
 * CellVoicePanel showing the whole cast as a scrollable chip strip. There's no
 * dropdown: clicking a chip assigns the line to that voice (aria-pressed flips)
 * and kicks off generation immediately.
 *
 * This spec:
 *   1. Creates a project, imports sample.md, opens the editor.
 *   2. Switches to audio mode.
 *   3. Creates a voice "Hero" via the New voice modal.
 *   4. Finds Hero's chip in the first cell (not yet active).
 *   5. Clicks it → the chip becomes the active voice (aria-pressed="true").
 */
test("clicking a voice chip assigns a line to that voice in audio mode", async ({ alice }) => {
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
  // show the cast chip strip.
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
  await dialog.getByRole("button", { name: /Create voice/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(voiceName)).toBeVisible({ timeout: 5_000 })

  // The voice column shows the cast as chips. Scope to the editor (main) so we
  // don't match the identically-named "Hero" row in the Voices dock panel.
  const heroChip = alice.getByRole("main").getByRole("button", { name: voiceName, exact: true }).first()
  await expect(heroChip).toBeVisible({ timeout: 8_000 })
  // The line resolves to the narrator by default, so Hero isn't active yet.
  await expect(heroChip).toHaveAttribute("aria-pressed", "false")

  // Clicking the chip assigns this line to Hero (and kicks off generation).
  await heroChip.click()
  await expect(heroChip).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 })
})
