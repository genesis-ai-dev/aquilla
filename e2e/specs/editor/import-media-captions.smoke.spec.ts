import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { jwtFor, mintSyncToken, readSeededFileEvents } from "../../helpers/seed-project"
import { alignChunks } from "../../../src/lib/audio/timings"
import type { CqrsEventPayloads as EventPayloads } from "../../../src/lib/sync/outbox-types"
import type { PersistedTrackPatch } from "../../../src/lib/timeline/tracks"

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

for (const source of ["paste", "file"] as const) {
test(`aligned paragraphs from ${source} reuse source timings and persist an independent track`, async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `Aligned script ${Date.now()}`, source: "en", target: "fr" })
  const settings = new ProjectSettings(alice)
  const projectId = settings.projectIdFromCurrentUrl()
  await settings.enableTimelineTracks(projectId)
  await settings.backToEditor()
  const ws = new Workspace(alice)
  const audio = await readFile(fileURLToPath(new URL("../../fixtures/tone-segments.mp3", import.meta.url)))
  await ws.previewMediaWithCaptions(
    { name: "aligned.mp3", mimeType: "audio/mpeg", buffer: audio },
    { name: "aligned.srt", mimeType: "text/plain", buffer: Buffer.from(captionSources.srt) },
  )
  await ws.confirmMediaPreview("aligned.mp3")
  await ws.openFileBySubstring("aligned.mp3")
  await ws.waitForEditor()
  await alice.getByRole("tab", { name: "Media", exact: true }).click()
  const fileId = new URL(alice.url()).pathname.split("/file/")[1]
  expect(fileId).toBeTruthy()
  const jwt = await jwtFor("alice")
  const events = await readSeededFileEvents(jwt, projectId, fileId)
  const attachments = events.filter(event => event.kind === "cell.audio.attach")
    .sort((a, b) => (a.payload as EventPayloads["cell.audio.attach"]).trimStartMs!
      - (b.payload as EventPayloads["cell.audio.attach"]).trimStartMs!)
  expect(attachments).toHaveLength(2)
  const token = await mintSyncToken(jwt, projectId, fileId)
  for (const [index, event] of attachments.entries()) {
    expect(event.cellId).toBeTruthy()
    const phrase = index === 0 ? "First caption." : "Second caption."
    // Seed the real Whisper timing producer's output through the event route.
    const timings = alignChunks([
      { text: index === 0 ? "First" : "Second", start: 0, end: 0.4 },
      { text: "caption", start: 0.5, end: 1 },
    ], phrase)
    const response = await alice.request.post(
      `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}/events`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { events: [{ schemaVersion: 1, id: randomUUID(), projectId, fileId,
          cellId: event.cellId, author: "alice", clientTs: Date.now(),
          kind: "cell.audio.attach", payload: {
            ...(event.payload as EventPayloads["cell.audio.attach"]), timings,
          } }] },
      },
    )
    expect(response.ok()).toBe(true)
  }
  await alice.reload()
  await ws.waitForEditor()
  const modelStarts: string[] = []
  alice.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/alignment/start")) {
      modelStarts.push(request.url())
    }
  })
  await alice.getByTestId("tl-sources-menu").click()
  await alice.getByRole("menuitem", { name: "Align script" }).click()
  const script = "First caption.\n\nSecond caption."
  const scriptBytes = source === "file"
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script.replace(/\n/g, "\r\n"))])
    : Buffer.from(script)
  if (source === "file") {
    await alice.getByLabel("Script file", { exact: true }).setInputFiles({
      name: "wording.txt", mimeType: "text/plain", buffer: scriptBytes,
    })
    await expect(alice.getByLabel("Script", { exact: true })).toHaveValue(script)
  } else {
    await alice.getByLabel("Script", { exact: true }).fill(script)
  }
  await alice.getByRole("button", { name: "Align script", exact: true }).click()
  await expect(alice.getByLabel("Segment 1 start (seconds)")).toHaveValue("0.5")
  await expect(alice.getByLabel("Segment 1 end (seconds)")).toHaveValue("1.5")
  await expect(alice.getByLabel("Segment 2 start (seconds)")).toHaveValue("2")
  await expect(alice.getByLabel("Segment 2 end (seconds)")).toHaveValue("3")
  await expect(alice.getByLabel("Destination track")).toHaveValue("$new-track")
  await alice.getByLabel("Segment 1 wording", { exact: true }).fill("Reviewed script wording.")
  await alice.getByLabel("Track name", { exact: true }).fill("Aligned paragraph track")
  await alice.getByRole("button", { name: "Use aligned segments", exact: true }).click()
  await expect(ws.modalDialogs()).toBeHidden()
  await ws.zoomTimelineIn()
  await expect(alice.getByTestId("tl-editor")).toContainText("Aligned paragraph track")
  await expect(alice.getByTestId("tl-editor")).toContainText("Reviewed script wording.")
  await expect(ws.sourceAudioClips()).toHaveCount(2)
  await expect(ws.cellRow(0)).toContainText("First caption.")
  expect(modelStarts).toEqual([])
  await alice.reload()
  await ws.waitForEditor()
  await expect(alice.getByTestId("tl-editor")).toContainText("Reviewed script wording.")
  await expect(ws.sourceAudioClips()).toHaveCount(2)
  const published = await readSeededFileEvents(jwt, projectId, fileId)
  const trackEvent = published.find(event => event.kind === "file.track.set"
    && (event.payload as { patch: PersistedTrackPatch | null }).patch?.name === "Aligned paragraph track")
  expect(trackEvent).toBeTruthy()
  const contentFileId = (trackEvent!.payload as { patch: PersistedTrackPatch | null }).patch?.contentFileId
  if (typeof contentFileId !== "string") throw new Error("Published track has no content file")
  const contentToken = await mintSyncToken(jwt, projectId, contentFileId)
  const original = await alice.request.get(
    `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
      + `/api/v1/projects/${projectId}/files/${contentFileId}/original`,
    { headers: { Authorization: `Bearer ${contentToken}` } },
  )
  expect(original.ok()).toBe(true)
  expect(await original.body()).toEqual(scriptBytes)
})
}

for (const format of ["m4a", "mp4"]) {
  test(`embedded ${format} captions define persisted source segments and preserve the original media`, async ({ alice }) => {
    const dash = new Dashboard(alice)
    await dash.goto()
    const name = `Embedded captions ${Date.now()}`
    await dash.createProject({ name, source: "en", target: "fr" })
    await dash.openProject(name)
    const ws = new Workspace(alice)
    const bytes = await readFile(fileURLToPath(new URL(
      `../../fixtures/embedded-captions.${format}`, import.meta.url,
    )))
    const mediaName = `embedded.${format}`
    await ws.previewEmbeddedMedia({ name: mediaName,
      mimeType: format === "mp4" ? "video/mp4" : "audio/mp4", buffer: bytes })
    await expect(alice.getByLabel("Segment 1 wording", { exact: true }))
      .toHaveValue("Embedded first caption.")
    await alice.getByLabel("Segment 1 wording", { exact: true }).fill("Reviewed embedded caption.")
    await ws.confirmMediaPreview(mediaName)
    await ws.openFileBySubstring(mediaName)
    await ws.waitForEditor()
    await alice.getByRole("tab", { name: "Media", exact: true }).click()
    await expect(ws.sourceAudioClips()).toHaveCount(2)
    await expect(ws.cellRow(0)).toContainText("Reviewed embedded caption.")
    await expect(ws.cellRow(0)).toContainText("00:00:00.500 --> 00:00:01.500")
    await expect(ws.cellRow(1)).toContainText("00:00:02.000 --> 00:00:03.000")
    if (format === "mp4") await ws.waitForLinkedVideo()
    await alice.reload()
    await ws.waitForEditor()
    await expect(ws.sourceAudioClips()).toHaveCount(2)
    await expect(ws.cellRow(0)).toContainText("Reviewed embedded caption.")
    await expect(ws.cellRow(1)).toContainText("Embedded second caption.")
    if (format === "mp4") {
      await ws.waitForLinkedVideo()
      // The transport enables seeking after a playback queue becomes active.
      await ws.playMedia()
      await expect.poll(() => ws.linkedVideo().evaluate(
        (element: HTMLVideoElement) => element.currentTime,
      )).toBeGreaterThan(0.15)
      await ws.pauseMedia()
      await ws.seekLinkedVideo(0.75)
    }
    const downloadPromise = alice.waitForEvent("download")
    await ws.clickDownloadOriginal()
    const download = await downloadPromise
    const path = await download.path()
    expect(path).not.toBeNull()
    expect(await readFile(path!)).toEqual(bytes)
    await ws.sourceAudioClips().first().click()
    await alice.getByRole("button", { name: "Play all", exact: true }).click()
    await expect(alice.getByText("0:02.0–0:03.0 | 1.0s", { exact: true })).toBeVisible()
  })
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
    response.ok(),
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
  await ws.sourceAudioClips().first().click()
  await expect(alice.getByText("0:00.5–0:01.5 | 1.0s", { exact: true })).toBeVisible()
  await alice.getByRole("button", { name: "Play all", exact: true }).click()
  const response = await audioResponse
  expect(response.ok()).toBe(true)
  expect(response.headers()["content-type"]).toContain("audio/mpeg")
  // Playback can use cached bytes after its one-byte availability probe.
  // Fetch the complete stored clip with the same authorization to verify R2.
  const authorization = response.request().headers()["authorization"]
  const stored = await alice.request.get(response.url(), {
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      Range: "bytes=0-",
    },
  })
  expect(stored.ok()).toBe(true)
  expect(stored.headers()["content-type"]).toContain("audio/mpeg")
  expect(await stored.body()).toEqual(audio)
  await expect(alice.getByText("0:02.0–0:03.0 | 1.0s", { exact: true })).toBeVisible()
})
}
