import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest"
import { setTranscriptionProvider } from "./transcription-preference"

const consent = vi.fn(async () => true)
vi.mock("./ai-consent", async original => ({
  ...await original<typeof import("./ai-consent")>(),
  requestAiModelConsent: () => consent(),
}))
const session = { username: "alice", jwt: "jwt", createdAt: "today" }
let transcription: typeof import("./transcribe")
let originalAudioContext: typeof AudioContext
beforeAll(async () => {
  originalAudioContext = window.AudioContext
  window.AudioContext = class {
    async decodeAudioData() {
      return { sampleRate: 16000, length: 16000, numberOfChannels: 1,
        copyFromChannel: (out: Float32Array) => out.fill(0),
        getChannelData: () => new Float32Array(16000) } as unknown as AudioBuffer
    }
    async close() {}
  } as unknown as typeof AudioContext
  transcription = await import("./transcribe")
})
beforeEach(() => { localStorage.clear(); consent.mockClear() })
afterEach(() => { transcription.__setWhisperWorkerForTests(null); vi.restoreAllMocks() })

function installWorker() {
  const listeners = new Set<(event: MessageEvent) => void>()
  const postMessage = vi.fn((message: { requestId: string }) => {
    queueMicrotask(() => {
      for (const listener of listeners) listener({ data: {
        type: "result", requestId: message.requestId, text: "local", chunks: [],
      } } as MessageEvent)
    })
  })
  transcription.__setWhisperWorkerForTests({
    addEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.delete(fn),
    postMessage,
  } as unknown as Worker)
  return postMessage
}

it("a new account transcribes through hosted Whisper without model consent", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ text: "hosted", chunks: [] }),
  )
  expect(await transcription.transcribeAudio(new Uint8Array(2), {
    session, projectId: "project",
  })).toEqual({ text: "hosted", chunks: [] })
  expect(fetchSpy).toHaveBeenCalledOnce()
  expect(consent).not.toHaveBeenCalled()
})
it("the account's local choice runs the worker even while signed in online", async () => {
  setTranscriptionProvider(session.username, "local")
  const fetchSpy = vi.spyOn(globalThis, "fetch")
  const postMessage = installWorker()
  expect(await transcription.transcribeAudio(new Uint8Array(2), {
    session, projectId: "project",
  })).toEqual({ text: "local", chunks: [] })
  expect(postMessage).toHaveBeenCalledOnce()
  expect(consent).toHaveBeenCalledOnce()
  expect(fetchSpy).not.toHaveBeenCalled()
})
it("switching accounts does not inherit another account's local choice", async () => {
  setTranscriptionProvider("alice", "local")
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ text: "hosted", chunks: [] }),
  )
  expect(await transcription.transcribeAudio(new Uint8Array(2), {
    session: { ...session, username: "bob" }, projectId: "project",
  })).toEqual({ text: "hosted", chunks: [] })
  expect(consent).not.toHaveBeenCalled()
})
it("signed-out transcription retains the local path", async () => {
  installWorker()
  const fetchSpy = vi.spyOn(globalThis, "fetch")
  expect(await transcription.transcribeAudio(new Uint8Array(2)))
    .toEqual({ text: "local", chunks: [] })
  expect(consent).toHaveBeenCalledOnce()
  expect(fetchSpy).not.toHaveBeenCalled()
})
// Restore the browser constructor for other tests in the same process.
import { afterAll } from "vitest"
afterAll(() => { window.AudioContext = originalAudioContext })
