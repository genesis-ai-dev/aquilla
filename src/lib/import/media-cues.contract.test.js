// Run the browser importer through the real worker routes and Postgres.
// JS keeps the browser and Workers TypeScript runtime libraries separate.
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitMediaFile } from "../import"
import { extractSrtStrings } from "../parsers/subtitle"
import { readFile } from "node:fs/promises"
import { prepareEmbeddedSubtitleSources } from "./embedded-subtitle-sources"
import { handleBulkImportRequest } from "../../../sync-worker/src/events/import-route"
import { handleSourceUploadRequest } from "../../../sync-worker/src/events/source-upload-route"
import { handleAudioRequest } from "../../../sync-worker/src/audio"
import { handleOriginalDownloadRequest } from "../../../sync-worker/src/events/original-download-route"
import { handleFilesReadRequest } from "../../../sync-worker/src/events/files-read-route"
import { makeTestDb } from "../../../sync-worker/src/__tests__/helpers/pg-test-db"
import { makeTestToken } from "../../../sync-worker/src/__tests__/helpers/auth"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("media wording import across browser and worker", () => {
  it.each(["sidecar", "m4a", "mp4"])("publishes %s wording with originals and source trims", async format => {
    const testDb = await makeTestDb()
    const objects = new Map()
    const env = {
      AQUILLA_PG: testDb.db,
      SYNC_SECRET_KEY: "media-cues-contract",
      SNAPSHOTS: {
        async put(key, body) {
          const bytes = await new Response(body).arrayBuffer()
          objects.set(key, bytes)
          return { key, size: bytes.byteLength }
        },
        async delete(key) { objects.delete(key) },
        async get(key) {
          const bytes = objects.get(key)
          return bytes ? { arrayBuffer: async () => bytes } : null
        },
      },
    }
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      // The browser's File and the worker's request boundary carry the exact
      // same bytes. No import, publication or artifact handler is mocked.
      const body = init.body instanceof File ? await init.body.arrayBuffer() : init.body
      const request = new Request(String(url), { ...init, body })
      const response = await handleBulkImportRequest(request, env)
        ?? await handleSourceUploadRequest(request, env)
        ?? await handleAudioRequest(request, env)
      if (!response) throw new Error(`Unhandled import request: ${request.method} ${request.url}`)
      return response
    }))
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
      const element = createElement(tag, options)
      if (tag === "audio" || tag === "video") {
        Object.defineProperty(element, "duration", { value: 3 })
        Object.defineProperty(element, "src", { set() {
          queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")))
        } })
      }
      return element
    })
    const text = "1\n00:00:00,500 --> 00:00:01,500\nSupplied wording." +
      "\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond paragraph."
    const subtitleBytes = new TextEncoder().encode(text).buffer
    const embedded = format !== "sidecar"
    const audio = embedded ? new File([
      await readFile(`e2e/fixtures/embedded-captions.${format}`),
    ], `clip.${format}`, { type: format === "mp4" ? "video/mp4" : "audio/mp4" })
      : new File(["source audio bytes"], "clip.mp3", { type: "audio/mpeg" })
    const sourceText = embedded
      ? prepareEmbeddedSubtitleSources(await audio.arrayBuffer())[0].source
      : { cues: extractSrtStrings(text),
        artifact: { name: "clip.srt", format: "srt", bytes: subtitleBytes } }
    try {
      const ref = await emitMediaFile(audio, format === "mp4" ? "video" : "audio", {
        projectId: "p1", author: "alice",
        getToken: fileId => makeTestToken(env.SYNC_SECRET_KEY, {
          projectId: "p1", fileId, role: 500,
        }),
        mediaTextSource: sourceText,
      })
      const [file] = await testDb.rows("files")
      expect(file.deleted_at).toBeNull()
      const source = (await testDb.rows("cells"))
        .filter(cell => cell.target_lang === "")
        .sort((a, b) => a.sequence_index - b.sequence_index)
      expect(source).toEqual([
        expect.objectContaining({ transcription: embedded ? "Embedded first caption." : "Supplied wording.", start_ms: 500, end_ms: 1500 }),
        expect.objectContaining({ transcription: embedded ? "Embedded second caption." : "Second paragraph.", start_ms: 2000, end_ms: 3000 }),
      ])
      const attachments = (await testDb.rows("cell_audio"))
        .sort((a, b) => a.trim_start_ms - b.trim_start_ms)
      expect(attachments).toEqual([
        expect.objectContaining({ trim_start_ms: 500, trim_end_ms: 1500 }),
        expect.objectContaining({ trim_start_ms: 2000, trim_end_ms: 3000 }),
      ])
      const artifacts = await testDb.rows("artifacts")
      expect(artifacts).toHaveLength(embedded ? 1 : 2)
      if (!embedded) expect(objects.get(artifacts.find(a => a.name === "clip.srt").r2_key))
        .toEqual(subtitleBytes)
      expect(objects.get(artifacts.find(a => a.name === audio.name).r2_key))
        .toEqual(await audio.arrayBuffer())
      expect(ref.cellCount).toBe(2)
      const token = await makeTestToken(env.SYNC_SECRET_KEY, {
        projectId: "p1", fileId: ref.id, role: 800,
      })
      const headers = { Authorization: `Bearer ${token}` }
      const original = await handleOriginalDownloadRequest(new Request(
        `https://x/api/v1/projects/p1/files/${ref.id}/original`, { headers },
      ), env)
      expect(original.status).toBe(200)
      expect(await original.arrayBuffer()).toEqual(await audio.arrayBuffer())
      const listing = await handleFilesReadRequest(new Request(
        "https://x/api/v1/projects/p1/files", { headers },
      ), env)
      expect((await listing.json()).files).toContainEqual(expect.objectContaining({
        fileId: ref.id, hasOriginalSource: true,
      }))
    } finally {
      await testDb.close()
    }
  }, 30_000)
})
