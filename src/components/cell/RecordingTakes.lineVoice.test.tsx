// AQU-1758 / AQU-2212: what the Audio view's voice card did for a line's take,
// in the line's Recording tab.
import { afterEach, describe, it, expect, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"

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
import { __resetVoicingAsForTests, whileVoicingAs } from "@/lib/audio/voicing-as"
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

  it("says Voicing as … while the line is voiced, in the button's place", async () => {
    draw(cast("v-hearth"), { onApplyLineVoice: vi.fn() })
    let done!: () => void
    let voicing!: Promise<void>
    act(() => { voicing = whileVoicingAs("c1", "Hearth", () => new Promise<void>((r) => { done = r })) })
    expect(screen.getByTestId("voice-card-working")).toHaveTextContent("Voicing as Hearth…")
    expect(screen.queryByTestId("voice-card-apply")).toBeNull()
    await act(async () => { done(); await voicing })
    expect(screen.queryByTestId("voice-card-working")).toBeNull()
    expect(screen.getByTestId("voice-card-apply")).toBeInTheDocument()
  })
})

describe("RecordingTakes — train a voice from this recording (AQU-1758, AQU-2291)", () => {
  it("hands over the line and the take that plays, in one click", () => {
    const onTrainFromTake = vi.fn()
    draw(cast(), { onTrainFromTake })
    fireEvent.click(screen.getByTestId("cell-take-train-voice"))
    expect(onTrainFromTake).toHaveBeenCalledWith("c1", T1)
  })
})
