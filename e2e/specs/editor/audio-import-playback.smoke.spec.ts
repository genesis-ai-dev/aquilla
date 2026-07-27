// E2E smoke test for the real audio import → silence-split → play journey.
//
// This is the first spec to import an actual audio file (every other audio
// spec exercises empty states only). The fixture is a committed ~60KB mp3
// (e2e/fixtures/tone-segments.mp3): 10s of 440Hz tone alternating with
// silence (1.2s on / 0.8s off), which detectSpeechSegments splits into 5
// media segments at the default thresholds (verified offline against
// src/lib/timeline/silence-split.ts).
//
// Journey under regression guard (this path broke silently for a tester —
// blob MIME + trim bugs in the play queue):
//   1. Import → Upload files with an mp3 — media files bypass the preview
//      panel and upload directly (file.create orderedBy='time' + N
//      source.cell.create segments sharing one uploaded clip).
//   2. The file's second lens is "Media" (time-ordered — AQU-353 labelling);
//      selecting it renders the TimelineEditor with one clip card per
//      detected segment (N > 1 proves silence-splitting ran, not the
//      single-whole-file fallback).
//   3. The bottom transport's "Play all" walks the segments through the
//      shared play-queue; the time readout advancing proves bytes actually
//      decoded and played, and no "Audio failed to load" state appears.

import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TONE_MP3 = path.resolve(__dirname, "../../fixtures/tone-segments.mp3")

test("alice imports an mp3, sees silence-split timeline clips, and plays them", async ({
  alice,
}) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AudioImport ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importMediaFile(TONE_MP3)

  // A fresh browser asks before downloading the local transcription model.
  // This journey exercises playback, not transcription, so explicitly decline
  // and prove the consent overlay no longer blocks the imported file.
  const modelConsent = alice.getByRole("dialog").filter({
    has: alice.getByRole("heading", {
      name: /Download Whisper \(transcription\)\?/i,
    }),
  })
  await expect(modelConsent).toBeVisible({ timeout: 10_000 })
  await modelConsent.getByRole("button", { name: /^Cancel$/i }).click()
  await expect(modelConsent).toBeHidden({ timeout: 5_000 })

  await ws.openFileBySubstring("tone-segments")

  // Time-ordered file → the second lens tab is labelled "Media" (AQU-353).
  const mediaTab = alice.getByRole("tab", { name: /^Media$/i })
  await expect(mediaTab).toBeVisible({ timeout: 10_000 })
  await mediaTab.click()
  await expect(mediaTab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 })

  // Timeline editor renders one clip card per silence-split segment. More
  // than one card proves the import actually split the audio instead of
  // falling back to a single whole-file segment.
  await expect(alice.getByTestId("tl-editor")).toBeVisible({ timeout: 10_000 })
  const clips = alice.locator('[data-testid^="tl-card-"]')
  await expect.poll(() => clips.count(), { timeout: 15_000 }).toBeGreaterThan(1)

  // Play all from the bottom transport. The button stays disabled until the
  // file's audio attachments hydrate (useFileAudioAttachments), so wait for
  // enabled rather than just visible.
  const playAll = alice.getByRole("button", { name: "Play all" })
  await expect(playAll).toBeEnabled({ timeout: 15_000 })
  await playAll.click()

  // Playing state: the same transport button flips to "Pause".
  await expect(alice.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 15_000 })

  // The time readout ("m:ss / m:ss") advances past zero — bytes decoded and
  // are audibly progressing, not a stalled/errored element.
  const readout = alice.getByText(/^\d+:\d{2} \/ \d+:\d{2}$/)
  await expect
    .poll(async () => ((await readout.textContent()) ?? "").split(" / ")[0], { timeout: 15_000 })
    .not.toBe("0:00")

  // The regression this spec guards: a bad blob MIME / trim range surfaces as
  // the play-queue's error state in the transport's status line.
  await expect(alice.getByText("Audio failed to load")).toHaveCount(0)
})
