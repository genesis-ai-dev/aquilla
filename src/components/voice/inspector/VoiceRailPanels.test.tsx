// The Voices rail's own panels (AQU-2577): clip inspector, Add a voice, Make speech.
//
// WHY these tests matter:
//   - The inspector writes delivery for ONE line. A tag or a model switch that
//     landed on the wrong key would change every line of a voice, or none.
//   - A library voice must be saved to the user's own ElevenLabs account before
//     it joins the cast: the id in the cast is the one their key can speak with.
//   - Make speech spends the user's characters. It must run on exactly the
//     lines picked, and say what happened to each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const listElevenLabsVoices = vi.fn()
const searchElevenLabsLibrary = vi.fn()
const addElevenLabsLibraryVoice = vi.fn()
vi.mock("@/lib/sync/elevenlabs", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/elevenlabs")>()),
  listElevenLabsVoices: (...a: unknown[]) => listElevenLabsVoices(...a),
  searchElevenLabsLibrary: (...a: unknown[]) => searchElevenLabsLibrary(...a),
  addElevenLabsLibraryVoice: (...a: unknown[]) => addElevenLabsLibraryVoice(...a),
  fetchElevenLabsAccount: vi.fn(async () => ({ tier: "creator", characterCount: 1, characterLimit: 100, canClone: true, resetAtUnix: null, quotaKnown: true })),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))

const { setElevenLabsKey } = await import("@/lib/audio/elevenlabs/key")
const { ClipInspector } = await import("./ClipInspector")
const { AddVoicePanel } = await import("./AddVoicePanel")
const { MakeSpeechPanel } = await import("./MakeSpeechPanel")

const session: FrontierSession = { jwt: "j", username: "dev", createdAt: "" }
const elevenVoice = (id: string, name: string, modelId?: string): Voice => ({
  id, name, provider: "elevenlabs", elevenLabs: { voiceId: `el-${id}`, modelId },
})

afterEach(() => act(() => setElevenLabsKey(undefined)))

describe("ClipInspector", () => {
  const cell = {
    id: "c1", translated: "هذا كان في البدء عند الله.",
    attachments: {
      "tts.mp3": { url: "frontier-audio://tts.mp3", type: "audio", voiceId: "layla", durationMs: 4000 },
      "vc-1-tts.mp3": { url: "frontier-audio://vc-1-tts.mp3", type: "audio", voiceId: "chip", referenceAudioId: "tts.mp3", durationMs: 4000, label: "Take 1 → Chip" },
    },
  } as unknown as CellData

  function renderInspector(voices: Voice[], settings: ProjectTtsSettings, audioId = "vc-1-tts.mp3") {
    const onSaveSettings = vi.fn()
    const onRegenerate = vi.fn()
    render(
      <ClipInspector
        cell={cell} audioId={audioId} settings={{ ...settings, voices }} allVoices={voices} voices={voices}
        projectId="p1" fileId="f1" session={session} language="ar" canEdit busy={false}
        onBack={vi.fn()} onSaveSettings={onSaveSettings} loadTake={vi.fn()} onRegenerate={onRegenerate}
        onPickVoice={vi.fn()} onAddVoice={vi.fn()}
      />,
    )
    return { onSaveSettings, onRegenerate }
  }

  it("says how the take was made, and a tag is saved for this line only", async () => {
    const voices = [elevenVoice("layla", "Layla", "eleven_v4"), elevenVoice("chip", "Chip")]
    const { onSaveSettings, onRegenerate } = renderInspector(voices, { lineDelivery: { other: { tags: ["laughs"] } } })
    const story = within(screen.getByTestId("clip-inspector-story"))
    expect(story.getByText("Spoken by Layla")).toBeInTheDocument()
    expect(story.getByText("Changed into Chip's voice")).toBeInTheDocument()
    // The delivery is the reader's (Layla read the text), not the character's.
    expect(screen.getByRole("button", { name: "All Layla lines" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "sighs" }))
    expect(onSaveSettings).toHaveBeenCalledWith({ lineDelivery: { other: { tags: ["laughs"] }, c1: { tags: ["sighs"] } } })

    fireEvent.click(screen.getByTestId("clip-inspector-regenerate"))
    await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1))
  })

  it("offers the model that performs tags when the voice's model would read them aloud", () => {
    const voices = [elevenVoice("layla", "Layla"), elevenVoice("chip", "Chip")]
    const { onSaveSettings } = renderInspector(voices, {})
    expect(screen.getByText(/Layla uses Multilingual v2, which would read a tag aloud/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Use Eleven v4 for this voice" }))
    const saved = onSaveSettings.mock.calls[0][0] as { voices: Voice[] }
    expect(saved.voices.map((v) => [v.id, v.elevenLabs?.modelId])).toEqual([["layla", "eleven_v4"], ["chip", undefined]])
  })

  it("keeps delivery controls away from a voice that is not an ElevenLabs one", () => {
    const voices: Voice[] = [{ id: "layla", name: "Layla", provider: "inworld" }, elevenVoice("chip", "Chip")]
    renderInspector(voices, {}, "tts.mp3")
    expect(screen.getByText(/can be set for ElevenLabs voices. Layla is not one/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "sighs" })).toBeNull()
    expect(screen.getByTestId("clip-inspector-regenerate")).toBeEnabled()
  })
})

describe("AddVoicePanel", () => {
  beforeEach(() => {
    act(() => setElevenLabsKey("sk_test"))
    listElevenLabsVoices.mockReset().mockResolvedValue({
      voices: [{ id: "el-chip", name: "Chip", category: "cloned", labels: {}, previewUrl: null, description: null }],
      nextPageToken: null,
    })
    searchElevenLabsLibrary.mockReset().mockResolvedValue({
      voices: [{ id: "lib1", ownerId: "owner9", name: "Layla", labels: { language: "ar", gender: "female" }, previewUrl: "https://p/l.mp3", description: null, added: false }],
      nextPage: null,
    })
    addElevenLabsLibraryVoice.mockReset().mockResolvedValue("el-added")
  })

  it("saves a library voice to the user's account, then adds it to the cast under that id", async () => {
    const onAdd = vi.fn()
    render(
      <AddVoicePanel
        projectId="p1" fileId="f1" session={session} voices={[elevenVoice("chip", "Chip")]} language="ar" languageLabel="Arabic"
        canEdit onBack={vi.fn()} onAdd={onAdd} onMakeNew={vi.fn()}
      />,
    )
    // Already in the project: no second Add for it.
    const account = within(await screen.findByTestId("add-voice-account"))
    expect(account.getByText("Already in this project")).toBeInTheDocument()
    // The library opens on the lane's language.
    expect(searchElevenLabsLibrary).toHaveBeenCalledWith(expect.objectContaining({ language: "ar" }), expect.any(Function))

    fireEvent.click(await screen.findByRole("button", { name: "Add Layla to this project" }))
    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    expect(addElevenLabsLibraryVoice).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner9", voiceId: "lib1", name: "Layla", apiKey: "sk_test" }), expect.any(Function),
    )
    expect(onAdd.mock.calls[0][0]).toMatchObject({ name: "Layla", provider: "elevenlabs", language: "ar", elevenLabs: { voiceId: "el-added" } })
  })
})

describe("MakeSpeechPanel", () => {
  const lines = [
    { cellId: "a", label: "First line", hasText: true, hasSpeech: false },
    { cellId: "b", label: "Second line", hasText: false, hasSpeech: false },
    { cellId: "done", label: "Already spoken", hasText: true, hasSpeech: true },
  ]
  function harness() {
    const calls: string[] = []
    const text = new Set(["a"])
    const actions = {
      hasText: (id: string) => text.has(id),
      translate: vi.fn(async (id: string) => { calls.push(`translate ${id}`); text.add(id); return true }),
      speak: vi.fn(async (id: string, voice: string | null, _delivery?: unknown) => { calls.push(`speak ${id} ${voice}`); return id !== "b" }),
      revoice: vi.fn(async (id: string, voice: string) => { calls.push(`revoice ${id} ${voice}`); return true }),
    }
    return { calls, actions }
  }
  beforeEach(() => localStorage.clear())

  it("opened from the roster, runs on the lines with no speech and says what happened to each", async () => {
    const { calls, actions } = harness()
    render(
      <MakeSpeechPanel
        projectId="p1" voices={[elevenVoice("layla", "Layla")]} targetLanguage="Arabic" selectedCellId={null} onBack={vi.fn()}
        actions={actions} lines={lines}
      />,
    )
    // Nothing is selected or picked, so the run starts on the lines that have no speech.
    fireEvent.click(screen.getByRole("button", { name: "Make speech for 2 lines" }))
    const progress = within(await screen.findByTestId("make-speech-progress"))
    await waitFor(() => expect(progress.getByText("2 of 2 done")).toBeInTheDocument())
    expect(calls).toEqual(["speak a null", "translate b", "speak b null"])
    expect(progress.getByText("First line").parentElement).toHaveTextContent("Done")
    expect(progress.getByText("Second line").parentElement).toHaveTextContent("Did not finish")
    expect(progress.queryByText("Already spoken")).toBeNull()
  })

  // Lines picked on the timeline: the panel is about exactly those, shows what
  // each step will do to them, and generates nothing until the button is pressed.
  it("for picked lines, shows the pipeline and runs it on those lines with the voices clicked", async () => {
    const { calls, actions } = harness()
    const onLineState = vi.fn()
    render(
      <MakeSpeechPanel
        projectId="p1" voices={[elevenVoice("layla", "Layla"), elevenVoice("chip", "Chip")]} targetLanguage="Arabic"
        selectedCellId="a" picked={["b"]} onBack={vi.fn()} actions={actions} lines={lines} onLineState={onLineState}
      />,
    )
    expect(within(screen.getByTestId("make-speech-picked")).getByText("Second line")).toBeInTheDocument()
    expect(screen.getByTestId("make-speech-translate-note")).toHaveTextContent("1 line has no text yet and will be translated first.")
    // The picked line is the target, not the line selected in the editor.
    expect(screen.queryByRole("button", { name: "The selected line" })).toBeNull()
    expect(calls).toEqual([])

    fireEvent.click(within(screen.getByRole("group", { name: "The voice that reads the text" })).getByRole("button", { name: "Layla" }))
    fireEvent.click(within(screen.getByRole("group", { name: "The voice it is changed into" })).getByRole("button", { name: "Chip" }))
    fireEvent.click(screen.getByRole("button", { name: "Make speech for 1 line" }))
    await waitFor(() => expect(onLineState).toHaveBeenCalledWith("b", { kind: "failed", step: "speak" }))
    expect(calls).toEqual(["translate b", "speak b layla"])
  })

  // Speed and tags are set before a line has any take: they go with the run,
  // and are kept on the lines so the clip inspector shows them afterwards.
  it("speaks the picked lines with the tags chosen in step 2, and keeps them on those lines", async () => {
    const { actions } = harness()
    const onSaveDelivery = vi.fn()
    render(
      <MakeSpeechPanel
        projectId="p1" voices={[elevenVoice("layla", "Layla")]} selectedCellId={null} picked={["a"]} onBack={vi.fn()}
        actions={actions} lines={lines.map((l) => ({ ...l, voiceId: "layla" }))} onSaveDelivery={onSaveDelivery}
      />,
    )
    fireEvent.click(within(screen.getByTestId("make-speech-tags")).getByRole("button", { name: "whispers" }))
    fireEvent.click(screen.getByRole("button", { name: "Make speech for 1 line" }))
    await waitFor(() => expect(actions.speak).toHaveBeenCalledWith("a", null, { settings: {}, tags: ["whispers"] }))
    expect(onSaveDelivery).toHaveBeenCalledWith(["a"], { settings: {}, tags: ["whispers"] })
  })

  it("offers no speed or tags when the voice that reads is not an ElevenLabs one", () => {
    const { actions } = harness()
    render(
      <MakeSpeechPanel
        projectId="p1" voices={[{ id: "plain", name: "Plain", provider: "inworld" }]} selectedCellId={null} picked={["a"]} onBack={vi.fn()}
        actions={actions} lines={lines.map((l) => ({ ...l, voiceId: "plain" }))} onSaveDelivery={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("make-speech-delivery")).toBeNull()
    expect(screen.getByText("Speed and tags can be set when an ElevenLabs voice reads the lines.")).toBeInTheDocument()
  })
})
