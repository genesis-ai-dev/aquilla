// AQU-1758 / AQU-2212: what the Audio view's voice card did for a line's take,
// in the line's Recording tab.
import { afterEach, describe, it, expect, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 4,
    peaks: null, peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
vi.mock("@/hooks/useRecordingTextDrift", () => ({ useRecordingTextDrift: () => new Map() }))
vi.mock("@/lib/audio/peaks-loader", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/peaks-loader")>()),
  loadPeaksFor: vi.fn(async () => null),
}))
vi.mock("@/lib/history/history", () => ({ recordStep: vi.fn(), withGroup: async (_l: unknown, fn: () => Promise<unknown>) => fn() }))

import { RecordingTakes } from "./RecordingTakes"
import { EditorActionsProvider, type EditorActionsContextValue } from "@/context/EditorActionsContext"
import { __resetVoicingAsForTests, setVoicingAs } from "@/lib/audio/voicing-as"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const project = { id: "p1", sourceLanguage: "en", targetLanguage: "es", audioMediaStrategy: "manual", files: [{ id: "f1" }] } as unknown as ProjectRecord
const T1 = "audio-c1-1.webm"
const narrator: Voice = { id: "v-narr", name: "Narrator", color: "#111", provider: "gemini", voiceName: "Kore" }
const john: Voice = { id: "v-john", name: "John", color: "#333", provider: "gemini", voiceName: "Puck" }
const hearth: Voice = { id: "v-hearth", name: "Hearth", color: "#222", libraryVoiceId: "narrator-hearth" }
const cast = (voiceId?: string): ProjectTtsSettings =>
  ({ voices: [narrator, john, hearth], defaultVoiceId: "v-narr", castAssignments: voiceId ? { c1: voiceId } : {} }) as ProjectTtsSettings

const recorded = {
  id: "c1", fileId: "f1", original: "Hola", translated: "Hello world", selectedAudioId: T1,
  attachments: { [T1]: { type: "audio", url: `frontier-audio://${T1}`, slot: "recording", durationMs: 4000, label: "Take 1" } },
} as unknown as CellData

function draw(settings: ProjectTtsSettings, actions: Partial<EditorActionsContextValue> = {}) {
  render(
    <EditorActionsProvider value={actions}>
      <RecordingTakes
        project={project} cell={recorded} cellText="Hello world" editable username="dir"
        session={{ jwt: "j", username: "dir" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
        ttsSettings={settings}
      />
    </EditorActionsProvider>,
  )
}

afterEach(() => __resetVoicingAsForTests())

describe("RecordingTakes — the line's voice and its take (AQU-2212)", () => {
  it("offers Change to … when the line's voice can re-voice its take, and runs it", () => {
    const onApplyLineVoice = vi.fn()
    draw(cast("v-hearth"), { onApplyLineVoice })
    const apply = screen.getByTestId("voice-card-apply")
    expect(apply).toHaveTextContent("Change to Hearth")
    fireEvent.click(apply)
    expect(onApplyLineVoice).toHaveBeenCalledWith("c1")
  })

  it("offers Generate · … for a stock voice cast over a recording", () => {
    draw(cast("v-john"), { onApplyLineVoice: vi.fn() })
    expect(screen.getByTestId("voice-card-apply")).toHaveTextContent("Generate · John")
  })

  it("offers nothing when nobody chose the line's voice", () => {
    draw(cast(), { onApplyLineVoice: vi.fn() })
    expect(screen.queryByTestId("voice-card-apply")).toBeNull()
  })

  // AQU-2037: which voice a line speaks with is the LANE's, but a take some
  // voice was cloned from is left alone whichever lane that voice is on — the
  // rule the workspace runs the click by. A voice another lane cloned from
  // this take is not in this lane's library.
  it("never offers to re-voice a take another lane's voice was cloned from", () => {
    const echo: Voice = { id: "v-echo", name: "Echo", color: "#444", provider: "inworld", voiceName: "echo", referenceAudioId: T1 } as Voice
    const lane = cast("v-hearth")
    const whole = { ...lane, voices: [...(lane.voices ?? []), echo] } as ProjectTtsSettings
    draw(lane, { onApplyLineVoice: vi.fn(), allTtsSettings: whole })
    // Not "Change to Hearth": what the click would do is read the text.
    expect(screen.getByTestId("voice-card-apply")).toHaveTextContent("Generate · Hearth")
  })

  it("says Voicing as … while the line is voiced, in the button's place", () => {
    draw(cast("v-hearth"), { onApplyLineVoice: vi.fn() })
    act(() => setVoicingAs("c1", "Hearth"))
    expect(screen.getByTestId("voice-card-working")).toHaveTextContent("Voicing as Hearth…")
    expect(screen.queryByTestId("voice-card-apply")).toBeNull()
    act(() => setVoicingAs("c1", null))
    expect(screen.queryByTestId("voice-card-working")).toBeNull()
    expect(screen.getByTestId("voice-card-apply")).toBeInTheDocument()
  })
})

describe("RecordingTakes — make a character from this voice, in one step (AQU-1758, AQU-2212)", () => {
  it("clones the take that plays: name it, Add to cast", async () => {
    const onCloneTake = vi.fn(async () => {})
    const onMakeCharacter = vi.fn()
    draw(cast(), { onCloneTake, onMakeCharacter })
    fireEvent.click(screen.getByTestId("voice-card-clone"))
    const popover = await screen.findByTestId("voice-card-clone-popover")
    const name = within(popover).getByTestId("voice-card-clone-name") as HTMLInputElement
    // Your own recording: you are the suggestion.
    expect(name.value).toBe("dir")
    fireEvent.change(name, { target: { value: "Dir" } })
    await act(async () => { fireEvent.click(within(popover).getByTestId("voice-card-clone-submit")) })
    expect(onCloneTake).toHaveBeenCalledWith("c1", T1, "Dir")
    expect(onMakeCharacter).not.toHaveBeenCalled()
  })

  it("keeps the full dialog under More options", async () => {
    const onMakeCharacter = vi.fn()
    draw(cast(), { onCloneTake: vi.fn(async () => {}), onMakeCharacter })
    fireEvent.click(screen.getByTestId("voice-card-clone"))
    const popover = await screen.findByTestId("voice-card-clone-popover")
    fireEvent.click(within(popover).getByRole("button", { name: "More options" }))
    expect(onMakeCharacter).toHaveBeenCalledWith("c1")
  })
})
