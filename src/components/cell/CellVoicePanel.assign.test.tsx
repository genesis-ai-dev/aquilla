import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"
import { useState } from "react"
import { useProjectTts } from "@/hooks/useProjectTts"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { CellSummary } from "@/hooks/useActiveCellStore"

// Keep the audio element + real synth out of this render — we only care that the
// card follows the line's assignment (AQU-768). Since 2026-09-28 the voice is
// picked in the row's gutter, not on the card; the card's Generate names it.
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 0,
    peaks: [], peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
const generateCellVoice = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true)) // success → fires onAfterGenerate (refresh)
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: (...a: unknown[]) => generateCellVoice(...a),
}))

import { CellVoicePanel } from "./CellVoicePanel"

const voices: Voice[] = [
  { id: "v-mary", name: "Mary", color: "#000", provider: "gemini", voiceName: "Kore", prompt: "{text}" },
  { id: "v-john", name: "John", color: "#111", provider: "gemini", voiceName: "Puck", prompt: "{text}" },
]

const cell: CellData = {
  id: "cell-1", fileId: "file-1", type: "text",
  translated: "hola", translatedHtml: "<p>hola</p>",
  attachments: {}, selectedGeneratedVoiceAudioId: undefined,
} as unknown as CellData

const cellSummaries: CellSummary[] = [
  { id: "cell-1", type: "text", translated: "hola" } as unknown as CellSummary,
]

function serverSettings(): ProjectTtsSettings {
  return { voices, defaultVoiceId: "v-mary" } as ProjectTtsSettings
}

const project = { id: "proj-1", name: "P", ttsSettings: serverSettings() } as unknown as ProjectRecord

// Mirror the workspace wiring: the panel resolves the active voice from
// `settings` itself; the gutter assigns through the same hook (stood in for by a
// button here); a successful generate swaps serverSettings identity (as
// useProject.refresh() does).
function Harness() {
  const [srv, setSrv] = useState(serverSettings())
  const tts = useProjectTts("proj-1", srv, cellSummaries, () => {})
  return (
    <>
      <button type="button" onClick={() => tts.assignCells([cell.id], "v-john")}>Cast John</button>
      <CellVoicePanel
        cell={cell}
        project={{ ...project, ttsSettings: tts.settings } as ProjectRecord}
        projectId="proj-1"
        settings={tts.settings}
        session={{ jwt: "x" } as unknown as never}
        username="tester"
        onRecord={() => {}}
        onAfterGenerate={() => setSrv(serverSettings())}
        onMakeCharacter={() => {}}
      />
    </>
  )
}

describe("CellVoicePanel follows the line's voice (AQU-768)", () => {
  beforeEach(() => { localStorage.clear(); generateCellVoice.mockClear() })

  it("names the newly cast voice on Generate, and keeps it through generate + refresh", async () => {
    render(<Harness />)
    // Nobody cast yet: the default/narrator (Mary).
    expect(screen.getByTestId("voice-card-generate")).toHaveTextContent("Generate · Mary")
    await act(async () => { fireEvent.click(screen.getByText("Cast John")) })
    await waitFor(() => expect(screen.getByTestId("voice-card-generate")).toHaveTextContent("Generate · John"))
    await act(async () => { fireEvent.click(screen.getByTestId("voice-card-generate")) })
    // Generated in the line's own voice…
    expect(generateCellVoice).toHaveBeenCalledTimes(1)
    expect((generateCellVoice.mock.calls[0][0] as { voiceId: string }).voiceId).toBe("v-john")
    // …and the AQU-768 regression (reverting to the previous voice after the
    // refresh) stays fixed.
    await waitFor(() => expect(screen.getByTestId("voice-card-generate")).toHaveTextContent("Generate · John"))
  })
})
