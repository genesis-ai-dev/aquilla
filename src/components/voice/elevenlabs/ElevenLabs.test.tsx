/**
 * ElevenLabs engine UI (AQU-2299): the one-row key connect → the muted
 * connected line, the voice grid (card select, avatar preview, search only for
 * big accounts), the "Clone a voice" card → clone step behind the consent gate
 * → Back, "Adjust" only once a voice is picked, and saving from New voice. The network client is mocked; its contract is pinned in
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
const { ElevenLabsVoiceBrowser, ELEVENLABS_SEARCH_THRESHOLD } = await import("./ElevenLabsVoiceBrowser")
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

const fileInput = () => screen.getByLabelText("Add recordings of the speaker")
const addRecording = () =>
  fireEvent.change(fileInput(), { target: { files: [new File([new Uint8Array([1])], "maria.wav", { type: "audio/wav" })] } })

describe("ElevenLabsConnectCard", () => {
  it("is one key row until connected, then one muted line with Disconnect", async () => {
    render(<ElevenLabsConnectCard projectId="p1" session={session} />)
    const input = screen.getByLabelText("ElevenLabs API key")
    expect(input).toHaveAttribute("type", "password")
    expect(input).toHaveAttribute("placeholder", "Paste your ElevenLabs API key")
    expect(screen.getByText(/Stays on this device/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Get a key/ })).toHaveAttribute("href", expect.stringContaining("elevenlabs.io"))

    fireEvent.change(input, { target: { value: "  sk_good  " } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    const line = await screen.findByTestId("elevenlabs-connected")
    expect(await within(line).findByText("87,660 characters left")).toBeInTheDocument()
    expect(fetchElevenLabsAccount).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", apiKey: "sk_good" }), expect.any(Function))
    expect(getElevenLabsKey()).toBe("sk_good")
    // No bar, meter or plan badge: the tier is only the line's tooltip.
    expect(screen.queryByRole("meter")).toBeNull()
    expect(screen.queryByText("Creator")).toBeNull()
    expect(line.querySelector("[title='Creator']")).not.toBeNull()

    fireEvent.click(within(line).getByRole("button", { name: "Disconnect" }))
    expect(getElevenLabsKey()).toBeUndefined()
    expect(screen.getByLabelText("ElevenLabs API key")).toBeInTheDocument()
  })

  it("keeps a rejected key off the device and says why under the input", async () => {
    const { ElevenLabsError } = await import("@/lib/audio/elevenlabs/errors")
    fetchElevenLabsAccount.mockRejectedValue(new ElevenLabsError("invalid key", "rejected"))
    render(<ElevenLabsConnectCard projectId="p1" session={session} />)
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: "sk_bad" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/disconnect and connect it again/)
    expect(screen.getByLabelText("ElevenLabs API key")).toHaveAttribute("aria-invalid", "true")
    expect(getElevenLabsKey()).toBeUndefined()
  })
})

describe("ElevenLabsVoiceBrowser", () => {
  it("selects a card, previews from the avatar, and has no kind filters", async () => {
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
    expect(screen.getByText("Premade · american · female")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Use Maria" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Use Maria" }).closest("li")).toHaveClass("ring-1")
    expect(screen.queryByRole("group")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Use Rachel" }))
    expect(onSelect).toHaveBeenCalledWith(VOICES[0])

    fireEvent.click(screen.getByRole("button", { name: "Play a preview of Rachel" }))
    expect(created).toEqual(["https://p/rachel.mp3"])
    expect(play).toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it("shows search only when the account has more than 12 voices", async () => {
    const many = Array.from({ length: ELEVENLABS_SEARCH_THRESHOLD + 1 }, (_, i): ElevenLabsVoiceRow => (
      { id: `v-${i}`, name: `Voice ${i}`, category: "premade", labels: {}, previewUrl: null, description: null }
    ))
    const exactly = many.slice(0, ELEVENLABS_SEARCH_THRESHOLD)
    listElevenLabsVoices.mockResolvedValue({ voices: exactly, nextPageToken: null })
    const { unmount } = render(<ElevenLabsVoiceBrowser projectId="p1" session={session} apiKey="k" onSelect={vi.fn()} />)
    expect(await screen.findByRole("button", { name: "Use Voice 0" })).toBeInTheDocument()
    expect(screen.queryByLabelText("Search ElevenLabs voices")).toBeNull()
    unmount()

    listElevenLabsVoices.mockResolvedValue({ voices: many, nextPageToken: null })
    render(<ElevenLabsVoiceBrowser projectId="p1" session={session} apiKey="k2" onSelect={vi.fn()} />)
    expect(await screen.findByLabelText("Search ElevenLabs voices")).toBeInTheDocument()
  })

  it("ends the grid with a Clone a voice card only when cloning is offered", async () => {
    const onClone = vi.fn()
    const { rerender } = render(<ElevenLabsVoiceBrowser projectId="p1" session={session} apiKey="k" onSelect={vi.fn()} onClone={onClone} />)
    fireEvent.click(await screen.findByRole("button", { name: "Clone a voice" }))
    expect(onClone).toHaveBeenCalled()
    rerender(<ElevenLabsVoiceBrowser projectId="p1" session={session} apiKey="k" onSelect={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Clone a voice" })).toBeNull()
  })
})

describe("ElevenLabsClonePanel", () => {
  it("won't clone without enough speech and the organization's consent; always removes noise", async () => {
    cloneElevenLabsVoice.mockResolvedValue({ voiceId: "new-1", requiresVerification: false, attestedAt: "t", statementVersion: "2026-10-23" })
    const onCloned = vi.fn()
    render(<ElevenLabsClonePanel name="Maria" projectId="p1" session={session} cells={[]} canClone onCloned={onCloned} onBack={vi.fn()} />)
    const button = () => screen.getByRole("button", { name: "Clone voice" })
    expect(button()).toBeDisabled()
    expect(screen.queryByRole("switch")).toBeNull()

    addRecording()
    expect(await screen.findByText("Total 0:30")).toBeInTheDocument()
    expect(button()).toBeDisabled()

    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(button()).toBeEnabled())
    fireEvent.click(button())
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith(expect.objectContaining({ voiceId: "new-1" })))
    expect(cloneElevenLabsVoice).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Maria", consentConfirmed: true, removeBackgroundNoise: true }),
      expect.any(Function),
    )
  })

  it("says the plan can't clone instead of offering the button", () => {
    render(<ElevenLabsClonePanel name="Maria" projectId="p1" session={session} cells={[]} canClone={false} onCloned={vi.fn()} onBack={vi.fn()} />)
    expect(screen.getByText(/plan can't clone voices/)).toBeInTheDocument()
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
    expect(screen.queryByRole("button", { name: "Clone a voice" })).toBeNull()

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

  it("shows Adjust only once a voice is picked, with just model, stability and speed", async () => {
    act(() => setElevenLabsKey("sk_device"))
    renderModal()
    fireEvent.click(screen.getByRole("button", { name: /ElevenLabs/ }))
    await screen.findByRole("button", { name: "Use Rachel" })
    expect(screen.queryByRole("button", { name: "Adjust" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Use Rachel" }))
    const adjust = screen.getByRole("button", { name: "Adjust" })
    expect(adjust).toHaveAttribute("aria-expanded", "false")
    expect(document.querySelector("input[type=range]")).toBeNull()

    fireEvent.click(adjust)
    expect(adjust).toHaveAttribute("aria-expanded", "true")
    // Base UI's thumbs have no layout in happy-dom, so count the range inputs.
    expect(document.querySelectorAll("input[type=range]")).toHaveLength(2)
    expect(screen.getByRole("group", { name: "Stability" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Speed" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Multilingual v2")
    expect(screen.queryByText("Similarity")).toBeNull()
    expect(screen.queryByText("Speaker boost")).toBeNull()
    expect(screen.getByRole("button", { name: "Hear it" })).toBeEnabled()
  })

  it("Clone a voice swaps the grid for the clone step, gated on consent, and Back returns", async () => {
    act(() => setElevenLabsKey("sk_device"))
    renderModal()
    fireEvent.click(screen.getByRole("button", { name: /ElevenLabs/ }))
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Maria" } })
    fireEvent.click(await screen.findByRole("button", { name: "Clone a voice" }))

    expect(screen.queryByRole("button", { name: "Use Rachel" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Create voice" })).toBeNull()
    addRecording()
    expect(await screen.findByText("Total 0:30")).toBeInTheDocument()
    const clone = screen.getByRole("button", { name: "Clone voice" })
    expect(clone).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(clone).toBeEnabled())

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(await screen.findByRole("button", { name: "Use Rachel" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create voice" })).toBeInTheDocument()
  })

  it("comes back from a clone to the grid with the new voice selected and marked Cloned", async () => {
    cloneElevenLabsVoice.mockResolvedValue({ voiceId: "new-1", requiresVerification: false, attestedAt: "t", statementVersion: "2026-10-23" })
    act(() => setElevenLabsKey("sk_device"))
    const { onSave } = renderModal()
    fireEvent.click(screen.getByRole("button", { name: /ElevenLabs/ }))
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Grandma" } })
    fireEvent.click(await screen.findByRole("button", { name: "Clone a voice" }))
    addRecording()
    await screen.findByText("Total 0:30")
    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(screen.getByRole("button", { name: "Clone voice" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Clone voice" }))

    const card = await screen.findByRole("button", { name: "Use Grandma" })
    expect(card).toHaveAttribute("aria-pressed", "true")
    expect(within(card.closest("li") as HTMLElement).getByText("Cloned")).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: "Create voice" }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      provider: "elevenlabs",
      elevenLabs: expect.objectContaining({ voiceId: "new-1", category: "cloned" }),
      elevenLabsClone: expect.objectContaining({ consentAttestedBy: "dev" }),
    }))
  })
})
