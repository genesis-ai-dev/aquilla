/**
 * ElevenLabs engine UI (AQU-2299): connecting the user's own key, picking an
 * account voice, cloning one behind the consent gate, and saving it from New
 * voice. The network client is mocked; its contract is pinned in
 * src/lib/sync/elevenlabs.test.ts and the worker's in sync-worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ElevenLabsVoiceRow } from "@/lib/sync/elevenlabs"
import type { FrontierSession } from "@/lib/frontier/types"

const account = { tier: "creator", characterCount: 12_340, characterLimit: 100_000, canClone: true, resetAtUnix: null }
const VOICES: ElevenLabsVoiceRow[] = [
  { id: "v-rachel", name: "Rachel", category: "premade", labels: { accent: "american", gender: "female" }, previewUrl: "https://p/rachel.mp3", description: null },
  { id: "v-maria", name: "Maria", category: "cloned", labels: {}, previewUrl: null, description: null },
]
const fetchElevenLabsAccount = vi.fn()
const listElevenLabsVoices = vi.fn()
const cloneElevenLabsVoice = vi.fn()
vi.mock("@/lib/sync/elevenlabs", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/elevenlabs")>()),
  fetchElevenLabsAccount: (...a: unknown[]) => fetchElevenLabsAccount(...a),
  listElevenLabsVoices: (...a: unknown[]) => listElevenLabsVoices(...a),
  cloneElevenLabsVoice: (...a: unknown[]) => cloneElevenLabsVoice(...a),
  previewElevenLabsTts: vi.fn(async () => new Blob([])),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
vi.mock("@/lib/sync/tts", () => ({
  listInworldVoices: vi.fn().mockResolvedValue([]),
  listInworldSupportedLanguages: vi.fn().mockResolvedValue([]),
  synthesizeCellTts: vi.fn(),
  designInworldVoice: vi.fn(),
  publishInworldVoice: vi.fn(),
}))
vi.mock("@/lib/import", async (orig) => ({
  ...(await orig<typeof import("@/lib/import")>()),
  probeDurationMsSafe: vi.fn(async () => 30_000),
}))

const { getElevenLabsKey, setElevenLabsKey } = await import("@/lib/audio/elevenlabs/key")
const { ElevenLabsConnectCard } = await import("./ElevenLabsConnectCard")
const { ElevenLabsVoiceBrowser } = await import("./ElevenLabsVoiceBrowser")
const { ElevenLabsClonePanel } = await import("./ElevenLabsClonePanel")
const { NewVoiceModal } = await import("@/components/voice/NewVoiceModal")

const session: FrontierSession = { jwt: "j", username: "dev", createdAt: "" }

beforeEach(() => {
  fetchElevenLabsAccount.mockReset().mockResolvedValue(account)
  listElevenLabsVoices.mockReset().mockResolvedValue({ voices: VOICES, nextPageToken: null })
  cloneElevenLabsVoice.mockReset()
})
afterEach(() => {
  act(() => setElevenLabsKey(undefined))
})

describe("ElevenLabsConnectCard", () => {
  it("validates a pasted key before saving it, then shows quota and disconnects", async () => {
    render(<ElevenLabsConnectCard projectId="p1" session={session} />)
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: "  sk_good  " } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(await screen.findByText("87,660 / 100,000 characters left")).toBeInTheDocument()
    expect(fetchElevenLabsAccount).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", apiKey: "sk_good" }), expect.any(Function))
    expect(getElevenLabsKey()).toBe("sk_good")
    expect(screen.getByText("Creator")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    expect(getElevenLabsKey()).toBeUndefined()
    expect(screen.getByLabelText("ElevenLabs API key")).toBeInTheDocument()
  })

  it("keeps a rejected key off the device and says why", async () => {
    const { ElevenLabsError } = await import("@/lib/audio/elevenlabs/errors")
    fetchElevenLabsAccount.mockRejectedValue(new ElevenLabsError("invalid key", "rejected"))
    render(<ElevenLabsConnectCard projectId="p1" session={session} />)
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: "sk_bad" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/disconnect and connect it again/)
    expect(getElevenLabsKey()).toBeUndefined()
  })
})

describe("ElevenLabsVoiceBrowser", () => {
  it("filters by kind, selects a card, and previews from the avatar", async () => {
    const play = vi.fn(async () => {})
    const created: string[] = []
    vi.stubGlobal("Audio", class {
      onended: (() => void) | null = null
      constructor(src: string) { created.push(src) }
      play = play
      pause = vi.fn()
    })
    const onSelect = vi.fn()
    render(<ElevenLabsVoiceBrowser projectId="p1" session={session} apiKey="k" onSelect={onSelect} selectedId="v-maria" />)

    expect(await screen.findByRole("button", { name: "Use Rachel" })).toBeInTheDocument()
    expect(screen.getByText("american · female")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Use Maria" })).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(within(screen.getByRole("group", { name: "Filter voices by kind" })).getByRole("button", { name: "Cloned" }))
    expect(screen.queryByRole("button", { name: "Use Rachel" })).toBeNull()
    fireEvent.click(within(screen.getByRole("group", { name: "Filter voices by kind" })).getByRole("button", { name: "Cloned" }))

    fireEvent.click(screen.getByRole("button", { name: "Use Rachel" }))
    expect(onSelect).toHaveBeenCalledWith(VOICES[0])

    fireEvent.click(screen.getByRole("button", { name: "Play a preview of Rachel" }))
    expect(created).toEqual(["https://p/rachel.mp3"])
    expect(play).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe("ElevenLabsClonePanel", () => {
  it("won't clone without enough speech and the organization's consent", async () => {
    cloneElevenLabsVoice.mockResolvedValue({ voiceId: "new-1", requiresVerification: false, attestedAt: "t", statementVersion: "2026-10-23" })
    const onCloned = vi.fn()
    render(<ElevenLabsClonePanel name="Maria" projectId="p1" session={session} cells={[]} canClone onCloned={onCloned} />)
    const button = () => screen.getByRole("button", { name: "Clone voice" })
    expect(button()).toBeDisabled()

    fireEvent.change(screen.getByLabelText("Add recordings of the speaker"), {
      target: { files: [new File([new Uint8Array([1])], "maria.wav", { type: "audio/wav" })] },
    })
    expect((await screen.findAllByText("0:30")).length).toBeGreaterThan(0)
    expect(button()).toBeDisabled()

    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(button()).toBeEnabled())
    fireEvent.click(button())
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith(expect.objectContaining({ voiceId: "new-1" })))
    expect(cloneElevenLabsVoice).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Maria", consentConfirmed: true, removeBackgroundNoise: false }),
      expect.any(Function),
    )
  })

  it("says the plan can't clone instead of offering the button", () => {
    render(<ElevenLabsClonePanel name="Maria" projectId="p1" session={session} cells={[]} canClone={false} onCloned={vi.fn()} />)
    expect(screen.getByText(/doesn't include instant voice cloning/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clone voice" })).toBeDisabled()
  })
})

describe("NewVoiceModal with ElevenLabs", () => {
  function renderModal() {
    const onSave = vi.fn()
    render(
      <NewVoiceModal
        open onClose={vi.fn()} voice={null} provider="inworld" isDefault={false} paletteIndex={0} cells={[]}
        onSave={onSave} projectId="p1" fileId="f1" session={session}
      />,
    )
    return { onSave }
  }

  it("asks to connect first, then saves the picked account voice as an ElevenLabs voice", async () => {
    const { onSave } = renderModal()
    fireEvent.click(screen.getByRole("button", { name: /ElevenLabs/ }))
    expect(screen.getByRole("form", { name: "Connect ElevenLabs" })).toBeInTheDocument()

    act(() => setElevenLabsKey("sk_device"))
    fireEvent.click(await screen.findByRole("button", { name: "Use Rachel" }))
    fireEvent.click(screen.getByRole("button", { name: "Create voice" }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: "Rachel",
      provider: "elevenlabs",
      elevenLabs: expect.objectContaining({ voiceId: "v-rachel", category: "premade", modelId: "eleven_multilingual_v2" }),
    }))
  })

  it("won't save an ElevenLabs voice with none picked", async () => {
    act(() => setElevenLabsKey("sk_device"))
    const { onSave } = renderModal()
    fireEvent.click(screen.getByRole("button", { name: /ElevenLabs/ }))
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Narrator 2" } })
    // Create voice waits for a pick rather than erroring after the click.
    const create = screen.getByRole("button", { name: "Create voice" })
    expect(create).toBeDisabled()
    fireEvent.click(create)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("hides Create voice while cloning: the panel's own Clone button is the action", async () => {
    act(() => setElevenLabsKey("sk_device"))
    renderModal()
    fireEvent.click(screen.getByRole("button", { name: /ElevenLabs/ }))
    fireEvent.click(await screen.findByRole("tab", { name: "Clone a voice" }))
    expect(screen.queryByRole("button", { name: "Create voice" })).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "Use a voice" }))
    expect(screen.getByRole("button", { name: "Create voice" })).toBeInTheDocument()
  })
})
