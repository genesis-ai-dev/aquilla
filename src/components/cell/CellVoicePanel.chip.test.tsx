import { describe, it, expect, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 10,
    peaks: [], peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: vi.fn(async () => true),
}))

import { CellVoicePanel } from "./CellVoicePanel"

const voices: Voice[] = [
  { id: "v-mary", name: "Mary", color: "#000", provider: "gemini", voiceName: "Kore", prompt: "{text}" },
]

const cell = {
  id: "cell-1", fileId: "file-1", type: "text",
  translated: "hola",
  selectedGeneratedVoiceAudioId: "a1",
  attachments: { a1: { url: "blob:x", type: "audio/wav" } },
} as unknown as CellData

const settings = { voices, defaultVoiceId: "v-mary" } as ProjectTtsSettings
const project = { id: "proj-1", name: "P", ttsSettings: settings } as unknown as ProjectRecord

describe("CellVoicePanel overlay chip", () => {
  function renderChip() {
    return renderWithTooltips(
      <CellVoicePanel
        cell={cell}
        project={project}
        projectId="proj-1"
        settings={settings}
        voices={voices}
        session={{ jwt: "x" } as unknown as never}
        username="tester"
        onAssign={() => {}}
        onAfterGenerate={() => {}}
        onMakeCharacter={() => {}}
      />,
    )
  }

  it("stays visible while a volume popover is open", async () => {
    const user = userEvent.setup()
    renderChip()

    const chip = document.querySelector("[data-slot=voice-overlay-chip]")
    expect(chip).toBeTruthy()
    expect(chip).toHaveClass("has-aria-expanded:opacity-100")

    const volume = screen.getByRole("button", { name: "Volume" })
    await user.click(volume)
    expect(volume).toHaveAttribute("aria-expanded", "true")
  })

  it("shows tooltips on crop and volume", async () => {
    renderChip()
    await expectTooltip(screen.getByRole("button", { name: "Crop audio" }), "Crop audio")
    await expectTooltip(screen.getByRole("button", { name: "Volume" }), "Volume")
  })
})
