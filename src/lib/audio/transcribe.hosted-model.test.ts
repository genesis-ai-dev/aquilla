// transcribeCell hands a run's hosted model to the transcription call.
//
// WHY: the Transcribe lens picks Fast or Smart for each run and passes it as
// `hostedModel` / `hostedQuietFallback`. transcribeCell builds the options for
// transcribeAudio by hand, so a field it does not copy is silently lost and
// the run uses the account's Preferences model instead of the lens's pick.

import "fake-indexeddb/auto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createOpfsFs } from "@/lib/fs/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/fs/__test__/mem-fs-handles"
import { __resetOpfsAvailabilityForTests } from "@/lib/storage/opfs-availability"
import { __setRootForTests, audioCachePut } from "./bytes-cache"
import { transcribeCell, __setTranscribeAudioForTests } from "./transcribe"
import { buildFrontierAudioUrl } from "./upload"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

vi.mock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: vi.fn(async () => "evt-1") }))

const AUDIO_ID = "audio-take-1"
const FULL_ID = `${AUDIO_ID}.webm`
const cell = {
  id: "cell-1", original: "hello", translated: "hola", fileId: "file-1",
  selectedAudioId: FULL_ID,
  attachments: { [FULL_ID]: { type: "audio", url: buildFrontierAudioUrl(AUDIO_ID, "webm") } },
} as unknown as CellData
const session: FrontierSession = { jwt: "jwt-x", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
const impl = vi.fn(async (_bytes: Uint8Array, _opts?: object) => ({ text: "hola", chunks: [{ text: "hola", start: 0, end: 1 }] }))

beforeEach(async () => {
  __resetOpfsAvailabilityForTests()
  __setRootForTests(createOpfsFs(new MemoryDirectoryHandle("root") as unknown as FileSystemDirectoryHandle))
  await audioCachePut(AUDIO_ID, "webm", new Uint8Array([1, 2, 3]))
  impl.mockClear()
  __setTranscribeAudioForTests(impl)
})
afterEach(() => { __setTranscribeAudioForTests(null) })

it("passes the run's hosted model and quiet fallback through", async () => {
  await transcribeCell({
    cell, session, projectId: "proj-1", hostedModel: "omni-zs", hostedQuietFallback: "omni-fast",
  })
  expect(impl.mock.calls[0][1]).toMatchObject({ hostedModel: "omni-zs", hostedQuietFallback: "omni-fast" })
})

it("sends neither field when the caller names no model, so Preferences decides", async () => {
  await transcribeCell({ cell, session, projectId: "proj-1" })
  expect(impl.mock.calls[0][1]).not.toHaveProperty("hostedModel")
  expect(impl.mock.calls[0][1]).not.toHaveProperty("hostedQuietFallback")
})
