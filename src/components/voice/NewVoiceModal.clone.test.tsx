/**
 * NewVoiceModal — the Clone voice tab: an Inworld quick clone from one short
 * clip (record, upload, or a line's recording). Always Inworld (no engine
 * picker), and never saved until the organization confirms the speaker's
 * consent — the same confirmation as Train voice and ElevenLabs cloning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NewVoiceModal } from "./NewVoiceModal"
import { uploadVoiceReference } from "@/lib/audio/voice-clone"
import { fetchTakeAsFile } from "@/lib/audio/take-file"
import type { CellData } from "@/hooks/useCells"
import type { TtsProvider, Voice } from "@/lib/parsers/types"

vi.mock("@/lib/sync/tts", () => ({
  listInworldVoices: vi.fn().mockResolvedValue([]),
  listInworldSupportedLanguages: vi.fn().mockResolvedValue([]),
  synthesizeCellTts: vi.fn(),
  designInworldVoice: vi.fn(),
  publishInworldVoice: vi.fn(),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
vi.mock("@/lib/audio/voice-clone", () => ({
  buildVoiceReferenceId: (ext: string) => `ref-new.${ext}`,
  uploadVoiceReference: vi.fn().mockResolvedValue(undefined),
  fetchVoiceReference: vi.fn(),
}))
vi.mock("@/lib/audio/upload", () => ({
  parseFrontierAudioUrl: vi.fn(), fetchCellAudio: vi.fn(), getCellAudioStreamUrl: vi.fn(),
  // The Clone voice tab's recorder reads the upload ceiling at import.
  MAX_AUDIO_UPLOAD_BYTES: 95 * 1024 * 1024,
}))
vi.mock("@/lib/audio/take-file", () => ({
  fetchTakeAsFile: vi.fn(async () => new File([new Uint8Array([1])], "Take 1.webm", { type: "audio/webm" })),
}))
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({ state: { kind: "idle" }, elapsedMs: 0, start: vi.fn(), stop: vi.fn(), reset: vi.fn() }),
}))

const session = { jwt: "j", username: "dev", createdAt: "" }

function renderModal({ voice = null, provider = "inworld", cells = [] }: {
  voice?: Voice | null
  provider?: TtsProvider
  cells?: CellData[]
} = {}) {
  const onSave = vi.fn()
  render(
    <NewVoiceModal
      open onClose={vi.fn()} voice={voice} provider={provider} targetLanguage="en" isDefault={false}
      paletteIndex={0} cells={cells} onSave={onSave} projectId="p1" fileId="f1" session={session}
    />,
  )
  return { onSave }
}

const openClone = () => fireEvent.click(screen.getByRole("tab", { name: /Clone voice/ }))
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create voice" }))
const uploadClip = () => {
  const input = screen.getByLabelText("Upload audio", { selector: "input" })
  fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "ana.wav", { type: "audio/wav" })] } })
}
const saved = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls[0][0] as Voice

const recordedCell = {
  id: "GEN 1:1", fileId: "f1", translated: "In the beginning", original: "", cellLabel: "1:1",
  selectedAudioId: "take-1.webm",
  attachments: { "take-1.webm": { url: "frontier-audio://take-1.webm", slot: "recording" } },
} as unknown as CellData

describe("NewVoiceModal Clone voice tab", () => {
  beforeEach(() => {
    vi.mocked(uploadVoiceReference).mockClear()
    vi.mocked(fetchTakeAsFile).mockClear()
  })

  it("says what a quick clone is, and has no engine picker", () => {
    renderModal({ provider: "gemini" })
    openClone()
    expect(screen.getByText("Quick clone from a short clip (Inworld). For a closer match, train a voice.")).toBeInTheDocument()
    expect(screen.queryByText("Engine")).toBeNull()
    expect(screen.getByRole("group", { name: "Add a reference clip" })).toBeInTheDocument()
    expect(screen.getByText("Consent is on your organization")).toBeInTheDocument()
    expect(screen.queryByText(/Seed-VC/)).toBeNull()
  })

  it("needs a clip, then the speaker's consent, before it saves an Inworld clone", async () => {
    const { onSave } = renderModal({ provider: "gemini" })
    openClone()
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Ana" } })

    create()
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reference clip before creating a cloned voice")

    uploadClip()
    await screen.findByText("Active")
    expect(uploadVoiceReference).toHaveBeenCalledWith(expect.objectContaining({ referenceAudioId: "ref-new.wav" }))

    create()
    expect(await screen.findByRole("alert")).toHaveTextContent("Confirm the speaker's consent before creating a cloned voice")
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("checkbox"))
    create()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const voice = saved(onSave)
    // A Gemini project still makes the clone on Inworld.
    expect(voice).toMatchObject({ name: "Ana", provider: "inworld", referenceAudioId: "ref-new.wav" })
    expect(voice.referenceTakeKey).toBeUndefined()
    expect(voice.libraryVoiceId).toBeUndefined()
  })

  it("reuses a line's recording as the clip", async () => {
    const { onSave } = renderModal({ cells: [recordedCell] })
    openClone()
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Ana" } })
    fireEvent.click(screen.getByRole("button", { name: /In the beginning/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: /In the beginning/ })).toHaveAttribute("aria-pressed", "true"))
    expect(fetchTakeAsFile).toHaveBeenCalledWith(expect.objectContaining({ audioId: "take-1.webm" }))
    expect(uploadVoiceReference).toHaveBeenCalledWith(expect.objectContaining({ referenceAudioId: "ref-new.webm", fileId: "f1" }))

    fireEvent.click(screen.getByRole("checkbox"))
    create()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(saved(onSave)).toMatchObject({
      provider: "inworld", referenceAudioId: "ref-new.webm", referenceTakeKey: "GEN 1:1:take-1.webm",
    })
  })

  it("an abandoned clip does not turn a TTS voice into a clone", async () => {
    const { onSave } = renderModal()
    openClone()
    uploadClip()
    await screen.findByText("Active")
    fireEvent.click(screen.getByRole("tab", { name: /TTS voice/ }))
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Plain" } })
    create()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(saved(onSave)).not.toHaveProperty("referenceAudioId")
  })

  it("edits an existing clone on its own tab; renaming needs no new consent", async () => {
    const clone: Voice = { id: "v-ana", name: "Ana", provider: "inworld", voiceName: "Dennis", referenceAudioId: "ref-ana.wav" }
    const { onSave } = renderModal({ voice: clone })
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.getByText("Active")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Ana B" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(saved(onSave)).toMatchObject({ id: "v-ana", name: "Ana B", referenceAudioId: "ref-ana.wav" })
  })

  it("opens a pre-AQU-2291 Gemini clone as a plain TTS voice (its clip is ignored)", () => {
    const legacy: Voice = { id: "v-old", name: "Old", provider: "gemini", voiceName: "Kore", referenceAudioId: "ref-old.wav" }
    renderModal({ voice: legacy })
    expect(screen.queryByText("Active")).toBeNull()
    expect(screen.getByText("Engine")).toBeInTheDocument()
  })
})
