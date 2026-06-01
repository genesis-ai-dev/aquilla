/**
 * E2E: Subtitle `<v Name>` round-trip
 *
 * Verifies that:
 *   1. Importing a VTT file with `<v Name>` voice tags creates one cast member
 *      per distinct speaker name, assigns the cells, and strips the tag from
 *      the displayed source text.
 *   2. Cells in the editor show the cast member name as a label (cell-labels
 *      view must be enabled for this assertion).
 *   3. Exporting as "WebVTT" produces a file whose cues contain `<v Name>` for
 *      explicitly-cast cells and plain text for unassigned cells.
 *
 * NOTE: This spec was authored but NOT executed (no dev stack in the current
 * environment). It relies on the seeded dev user ("alice") and the fixture at
 * e2e/fixtures/voices-roundtrip.vtt.
 */

import path from "node:path"
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const FIXTURE = path.resolve(__dirname, "../../fixtures/voices-roundtrip.vtt")

test("import VTT with <v Name> tags → cast created → export round-trip", async ({ alice }) => {
  // ── 1. Create a project ───────────────────────────────────────────────────
  const dash = new Dashboard(alice)
  await dash.goto()
  const projectName = `VoiceRoundtrip ${Date.now()}`
  await dash.createProject({ name: projectName, source: "en", target: "fr" })
  await alice.getByText(projectName).click()

  const ws = new Workspace(alice)
  await ws.waitForEditor()

  // ── 2. Import the VTT fixture ─────────────────────────────────────────────
  await ws.importFile(FIXTURE)

  // After import the dialog closes; the sidebar should show the file.
  await expect(alice.getByText("voices-roundtrip.vtt")).toBeVisible({ timeout: 10_000 })
  await ws.openFileBySubstring("voices-roundtrip")
  await ws.waitForEditor()

  // ── 3. Verify cast members were created ───────────────────────────────────
  // Open the Voice Studio / Cast panel to inspect the voice library.
  await alice.getByRole("button", { name: /voice studio|cast/i }).click()
  await expect(alice.getByText("Mary")).toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText("John")).toBeVisible({ timeout: 5_000 })
  // Close the studio panel.
  await alice.keyboard.press("Escape")

  // ── 4. Verify source text is stripped of the voice tag ─────────────────────
  // Cell 0 should show "In the beginning was the Word." (no <v> wrapper).
  const firstCell = ws.cellRow(0)
  await expect(firstCell).not.toContainText("<v Mary>")
  await expect(firstCell).toContainText("In the beginning was the Word.")

  // ── 5. Enable cell labels and verify cast name appears ────────────────────
  // Toggle cell labels (exact button name depends on UI; adjust if needed).
  const labelsToggle = alice.getByRole("button", { name: /cell labels/i })
  if (await labelsToggle.isVisible()) {
    await labelsToggle.click()
  }
  // Cells assigned to Mary should show "Mary" as their label.
  await expect(alice.locator("[data-cell-id]").first().getByText("Mary")).toBeVisible({
    timeout: 5_000,
  })

  // ── 6. Export as WebVTT ────────────────────────────────────────────────────
  // Open export dialog.
  await alice.getByRole("button", { name: /export/i }).click()
  await expect(alice.getByRole("dialog", { name: /export/i })).toBeVisible({ timeout: 5_000 })

  // Select "WebVTT (subtitles)" format.
  await alice.getByText("WebVTT").click()

  // Trigger download and capture the blob.
  const [download] = await Promise.all([
    alice.waitForEvent("download"),
    alice.getByRole("button", { name: /download/i }).click(),
  ])

  // Read the downloaded file content.
  const readable = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of readable) chunks.push(Buffer.from(chunk))
  const content = Buffer.concat(chunks).toString("utf-8")

  // ── 7. Assert round-trip fidelity ─────────────────────────────────────────
  expect(content).toContain("WEBVTT")
  // Cast-assigned cells should carry the voice tag.
  expect(content).toContain("<v Mary>")
  expect(content).toContain("<v John>")
  // Timecodes should be present (from the Plan A timecode persistence).
  expect(content).toContain("00:00:01.000 --> 00:00:03.000")
  expect(content).toContain("00:00:03.500 --> 00:00:05.500")
  // The unassigned narrator line should be plain text (no voice tag).
  expect(content).toContain("Plain narrator line with no voice tag.")
  expect(content).not.toMatch(/<v [^>]+>Plain narrator/)
})
