import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"
import { useState } from "react"
import { useProjectTts } from "@/hooks/useProjectTts"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { CellSummary } from "@/hooks/useActiveCellStore"

// Keep the audio element + real synth out of this render — we only care that the
// cast combobox reflects the assignment (AQU-768).
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 0,
    peaks: [], peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: vi.fn(async () => true), // success → fires onAfterGenerate (refresh)
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
// `settings` itself; onAssign persists via the same hook; a successful generate
// swaps serverSettings identity (as useProject.refresh() does).
function Harness() {
  const [srv, setSrv] = useState(serverSettings())
  const tts = useProjectTts("proj-1", srv, cellSummaries, () => {})
  return (
    <CellVoicePanel
      cell={cell}
      project={{ ...project, ttsSettings: tts.settings } as ProjectRecord}
      projectId="proj-1"
      settings={tts.settings}
      voices={tts.voices}
      session={{ jwt: "x" } as unknown as never}
      username="tester"
      onAssign={(voiceId) => tts.assignCells([cell.id], voiceId)}
      onAfterGenerate={() => setSrv(serverSettings())}
      onMakeCharacter={() => {}}
    />
  )
}

describe("CellVoicePanel per-cell voice pick (AQU-768)", () => {
  beforeEach(() => localStorage.clear())

  it("keeps the newly picked voice shown in the trigger, through generate + refresh", async () => {
    render(<Harness />)

    // Trigger starts on the default/narrator (Mary).
    expect(screen.getByRole("button", { name: /Voice: Mary/ })).toBeTruthy()

    // Open the combobox and pick John.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Voice: Mary/ }))
    })
    const johnOption = await screen.findByText("John")
    await act(async () => {
      fireEvent.click(johnOption)
    })

    // The trigger must now show John and stay there (the AQU-768 regression was
    // it reverting to the previously-active voice after the pick + refresh).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Voice: John/ })).toBeTruthy(),
    )
  })
})
