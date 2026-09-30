import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

// AQU-1479: the real SPA parser, staged publication, Postgres projection, and
// R2 clip must agree on supplied wording and trim boundaries after reload.
const captionSources = {
  srt: "1\n00:00:00,500 --> 00:00:01,500\nFirst caption.\n\n" +
    "2\n00:00:02,000 --> 00:00:03,000\nSecond caption.\n",
  vtt: "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nFirst caption.\n\n" +
    "00:00:02.000 --> 00:00:03.000\nSecond caption.\n",
  sbv: "0:00:00.500,0:00:01.500\nFirst caption.\n\n" +
    "0:00:02.000,0:00:03.000\nSecond caption.\n",
}

test("attaching captions adds a track and counted overwrite preserves source audio", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Caption tracks ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  const settings = new ProjectSettings(alice)
  await settings.enableTimelineTracks(settings.projectIdFromCurrentUrl())
  await settings.backToEditor()
  const ws = new Workspace(alice)
  const audio = await readFile(fileURLToPath(new URL("../../fixtures/tone-segments.mp3", import.meta.url)))
  await ws.previewMediaWithCaptions(
    { name: "tracked.mp3", mimeType: "audio/mpeg", buffer: audio },
    { name: "tracked.srt", mimeType: "text/plain", buffer: Buffer.from(captionSources.srt) },
  )
  await ws.confirmMediaPreview("tracked.mp3")
  await ws.openFileBySubstring("tracked.mp3")
  await ws.waitForEditor()
  await alice.getByRole("tab", { name: "Media", exact: true }).click()
  await ws.previewCaptionTrack({ name: "new-captions.srt", mimeType: "text/plain", buffer: Buffer.from(
    "1\n00:00:00,750 --> 00:00:01,750\nAttached caption wording.",
  ) })
  await expect(alice.getByLabel("Destination track")).toHaveValue("$new-track")
  await alice.getByLabel("Track name", { exact: true }).fill("Reviewed caption track")
  await ws.confirmCaptionTrack()
  // A one-second chip is 38px at the default zoom; the shared card only
  // renders wording once it has 40px. Inspect the wording at readable zoom.
  await ws.zoomTimelineIn()
  await expect(alice.getByTestId("tl-editor")).toContainText("Attached caption wording.")
  await alice.getByTestId("tl-editor").getByText("Attached caption wording.", { exact: true })
    .scrollIntoViewIfNeeded()
  await expect(alice.getByTestId("tl-editor").getByText("Attached caption wording.", { exact: true }))
    .toBeVisible()
  await expect(ws.sourceAudioClips()).toHaveCount(2)
  await expect(ws.cellRow(0)).toContainText("First caption.")
  await alice.reload()
  await ws.waitForEditor()
  await expect(alice.getByTestId("tl-editor")).toContainText("Reviewed caption track")
  await expect(alice.getByTestId("tl-editor")).toContainText("Attached caption wording.")
  await ws.previewCaptionTrack({ name: "replacement.srt", mimeType: "text/plain", buffer: Buffer.from(
    "1\n00:00:01,000 --> 00:00:02,500\nReplacement wording.",
  ) })
  await alice.getByLabel("Destination track").selectOption({ label: "Reviewed caption track" })
  await expect(alice.getByText("1 segment currently in this track will be overwritten.")).toBeVisible()
  await expect(alice.getByRole("button", { name: "Overwrite caption track" })).toBeDisabled()
  await alice.getByRole("checkbox", { name: "Overwrite the existing content in this track" }).check()
  await ws.confirmCaptionTrack(true)
  await expect(alice.getByTestId("tl-editor")).toContainText("Replacement wording.")
  await expect(alice.getByTestId("tl-editor")).not.toContainText("Attached caption wording.")
  await expect(ws.sourceAudioClips()).toHaveCount(2)
  await expect(ws.cellRow(0)).toContainText("First caption.")
  await alice.reload()
  await ws.waitForEditor()
  await expect(alice.getByTestId("tl-editor")).toContainText("Replacement wording.")
  await expect(ws.sourceAudioClips()).toHaveCount(2)
  await alice.getByTestId("tl-editor").getByText("Replacement wording.", { exact: true })
    .scrollIntoViewIfNeeded()
  await expect(alice.getByTestId("tl-editor").getByText("Replacement wording.", { exact: true }))
    .toBeVisible()
  await alice.screenshot({ path: "/private/tmp/aquilla-caption-track-overwrite.png" })
})

for (const [format, captions] of Object.entries(captionSources)) {
test(`media and ${format} captions publish reviewed segments and playable audio`, async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Media captions ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)
  const ws = new Workspace(alice)
  const audio = await readFile(fileURLToPath(new URL("../../fixtures/tone-segments.mp3", import.meta.url)))
  await ws.previewMediaWithCaptions(
    { name: "companion.mp3", mimeType: "audio/mpeg", buffer: audio },
    { name: `companion.${format}`, mimeType: "text/plain", buffer: Buffer.from(captions) },
  )
  await alice.getByLabel("Segment 1 wording", { exact: true }).fill("Reviewed first caption.")
  // Timeline hydration may prefetch the same bytes playback uses. Observe
  // publication onward rather than requiring a redundant GET after Play.
  const audioResponse = alice.waitForResponse(response =>
    /\/audio\/[^/?]+/.test(response.url()) &&
    response.request().method() === "GET" &&
    Number(response.headers()["content-length"]) === audio.length,
    { timeout: 30_000 },
  )
  await ws.confirmMediaPreview("companion.mp3")
  await ws.openFileBySubstring("companion.mp3")
  await ws.waitForEditor()
  await alice.getByRole("tab", { name: "Media", exact: true }).click()
  await expect(ws.sourceAudioClips()).toHaveCount(2)
  await expect(ws.cellRow(0)).toContainText("Reviewed first caption.")
  await expect(ws.cellRow(0)).toContainText("00:00:00.500 --> 00:00:01.500")
  await expect(ws.cellRow(1)).toContainText("00:00:02.000 --> 00:00:03.000")

  await alice.reload()
  await ws.waitForEditor()
  await expect(ws.sourceAudioClips()).toHaveCount(2)
  await expect(ws.cellRow(0)).toContainText("Reviewed first caption.")
  await expect(ws.cellRow(1)).toContainText("Second caption.")
  await alice.screenshot({ path: `/private/tmp/aquilla-media-captions-${format}.png` })
  await ws.sourceAudioClips().first().click()
  await expect(alice.getByText("0:00.5–0:01.5 | 1.0s", { exact: true })).toBeVisible()
  await alice.getByRole("button", { name: "Play all", exact: true }).click()
  const response = await audioResponse
  expect(response.ok()).toBe(true)
  expect(response.headers()["content-type"]).toContain("audio/mpeg")
  expect(await response.body()).toEqual(audio)
  await expect(alice.getByText("0:02.0–0:03.0 | 1.0s", { exact: true })).toBeVisible()
})
}
