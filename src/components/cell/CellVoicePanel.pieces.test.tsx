// AQU-1767 (Sam, 2026-10-15): a piece of a split voice trims back out on the
// card only as far as its neighbouring piece, as it does on the timeline.
import { describe, it, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"
import { renderWithTooltips } from "@/test-utils/tooltip"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 10,
    peaks: [], peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
const persistTakeTrim = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "evt"))
vi.mock("@/lib/audio/persist-trim", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistTakeTrim: (...a: unknown[]) => persistTakeTrim(...a),
}))

import { CellVoicePanel } from "./CellVoicePanel"

const settings = { voices: [], defaultVoiceId: undefined } as unknown as ProjectTtsSettings
const project = { id: "proj-1", name: "P", ttsSettings: settings } as unknown as ProjectRecord

// A 10s voice cut at 5s, then trimmed: piece 1 ends at 4s, piece 2 starts at 6s.
const split = {
  id: "cell-1", fileId: "file-1", type: "text", translated: "hola",
  selectedGeneratedVoiceAudioId: "a1",
  attachments: {
    a1: { url: "blob:x", type: "audio/wav", slot: "generatedVoice", trimEndMs: 4000 },
    a2: { url: "blob:x", type: "audio/wav", slot: "generatedVoice", pieceOf: "a1", trimStartMs: 6000 },
  },
} as unknown as CellData

describe("CellVoicePanel — a piece of a split voice", () => {
  it("trims its end back out only as far as where the next piece starts", () => {
    const panel = (cell: CellData) => (
      <CellVoicePanel
        cell={cell} project={project} projectId="proj-1" settings={settings}
        session={{ jwt: "x" } as unknown as never} username="tester"
        onRecord={() => {}} onAfterGenerate={() => {}} onMakeCharacter={() => {}}
      />
    )
    const { rerender } = renderWithTooltips(panel(split))
    // 30 coarse steps of 0.1s would carry it to 7s. Each saved step comes back
    // as the stored trim, as the sync would bring it.
    let cell = split
    for (let i = 0; i < 30; i++) {
      fireEvent.keyDown(screen.getByRole("slider", { name: "End of the kept audio" }), { key: "ArrowRight", shiftKey: true })
      const saved = persistTakeTrim.mock.calls.at(-1)?.[0] as { audioId: string; trimEndMs: number | null }
      expect(saved.audioId).toBe("a1")
      const atts = cell.attachments as Record<string, object>
      cell = { ...cell, attachments: { ...atts, a1: { ...atts.a1, trimEndMs: saved.trimEndMs } } } as unknown as CellData
      rerender(panel(cell))
    }
    const last = persistTakeTrim.mock.calls.at(-1)?.[0] as { trimEndMs: number | null }
    expect(last.trimEndMs).toBe(6000)
  })
})
