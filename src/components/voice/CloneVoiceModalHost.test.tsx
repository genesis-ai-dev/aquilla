/**
 * CloneVoiceModalHost.test.tsx — AQU-1001 in-cell Clone voice entry point.
 *
 * The New voice modal used to live only inside the Voices dock tab, so
 * clicking Clone on a source cell did nothing until that tab mounted. The
 * host must open the modal in place (clone tab, seeded to the cell) and
 * persist a created voice onto the project library.
 */

import { describe, it, expect, vi } from "vitest"
import { useState } from "react"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NewVoiceModalProps } from "./NewVoiceModal"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { ProjectTtsApi } from "@/hooks/useProjectTts"
import { renderWithTooltips } from "@/test-utils/tooltip"

const modalProps: { last: NewVoiceModalProps | null } = { last: null }
vi.mock("./NewVoiceModal", () => ({
  NewVoiceModal: (props: NewVoiceModalProps) => {
    modalProps.last = props
    return props.open ? (
      <div
        data-testid="new-voice-modal"
        data-mode={props.initialMode}
        data-seed={props.seedCellId ?? ""}
      />
    ) : null
  },
}))

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

import { CloneVoiceModalHost } from "./CloneVoiceModalHost"
import { CellVoicePanel } from "@/components/cell/CellVoicePanel"

const narrator: Voice = { id: "v-narrator", name: "Narrator", color: "#475569", provider: "gemini", voiceName: "Charon" }

function makeTts(over: Partial<ProjectTtsApi> = {}): ProjectTtsApi {
  const settings: ProjectTtsSettings = { provider: "gemini", voices: [narrator], defaultVoiceId: narrator.id }
  return {
    settings,
    voices: [narrator],
    defaultVoiceId: narrator.id,
    castStats: new Map(),
    saveTts: vi.fn(async () => {}),
    assignCells: vi.fn(),
    ...over,
  }
}

const cell = {
  id: "cell-1", fileId: "file-1", type: "text",
  translated: "hola",
  selectedGeneratedVoiceAudioId: "a1",
  attachments: { a1: { url: "blob:x", type: "audio/wav" } },
} as unknown as CellData

const project = { id: "proj-1", name: "P" } as unknown as ProjectRecord

describe("CloneVoiceModalHost", () => {
  it("does not render the modal while closed", () => {
    modalProps.last = null
    renderWithTooltips(
      <CloneVoiceModalHost
        open={false}
        onClose={() => {}}
        seedCellId="cell-1"
        tts={makeTts()}
        projectId="proj-1"
        session={null}
        cells={[]}
      />,
    )
    expect(screen.queryByTestId("new-voice-modal")).toBeNull()
  })

  it("opens on the clone tab, seeded to the source cell", () => {
    modalProps.last = null
    renderWithTooltips(
      <CloneVoiceModalHost
        open
        onClose={() => {}}
        seedCellId="cell-1"
        tts={makeTts()}
        projectId="proj-1"
        session={null}
        cells={[]}
      />,
    )
    const modal = screen.getByTestId("new-voice-modal")
    expect(modal.getAttribute("data-mode")).toBe("clone")
    expect(modal.getAttribute("data-seed")).toBe("cell-1")
    expect(modalProps.last?.voice).toBeNull()
    expect(modalProps.last?.provider).toBe("gemini")
  })

  it("persists a created voice onto the project library", () => {
    const saveTts = vi.fn(async () => {})
    modalProps.last = null
    renderWithTooltips(
      <CloneVoiceModalHost
        open
        onClose={() => {}}
        seedCellId="cell-1"
        tts={makeTts({ saveTts })}
        projectId="proj-1"
        session={null}
        cells={[]}
      />,
    )
    const created: Voice = {
      id: "v-clone",
      name: "Keean",
      color: "#0d9488",
      referenceAudioId: "ref.webm",
    }
    modalProps.last!.onSave(created)
    expect(saveTts).toHaveBeenCalledTimes(1)
    const patch = saveTts.mock.calls[0][0]
    expect(patch.voices).toEqual([narrator, created])
    expect(patch.defaultVoiceId).toBe(narrator.id)
  })

  it("does not persist when the caller is below the maintainer floor", () => {
    const saveTts = vi.fn(async () => {})
    modalProps.last = null
    renderWithTooltips(
      <CloneVoiceModalHost
        open
        onClose={() => {}}
        seedCellId="cell-1"
        tts={makeTts({ saveTts })}
        projectId="proj-1"
        session={null}
        cells={[]}
        roleLevel={400}
      />,
    )
    modalProps.last!.onSave({ id: "v-clone", name: "Keean", color: "#0d9488" })
    expect(saveTts).not.toHaveBeenCalled()
  })
})

describe("Clone voice button → New voice modal (AQU-1001)", () => {
  it("opens the clone modal in place from a source cell's audio controls", async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      const [seed, setSeed] = useState<string | null>(null)
      const settings: ProjectTtsSettings = { voices: [narrator], defaultVoiceId: narrator.id }
      return (
        <>
          <CellVoicePanel
            cell={cell}
            project={project}
            projectId="proj-1"
            settings={settings}
            voices={[narrator]}
            session={{ jwt: "x" } as unknown as never}
            username="tester"
            onAssign={() => {}}
            onAfterGenerate={() => {}}
            onMakeCharacter={() => {
              setSeed(cell.id)
              setOpen(true)
            }}
          />
          <CloneVoiceModalHost
            open={open}
            onClose={() => setOpen(false)}
            seedCellId={seed}
            tts={makeTts()}
            projectId="proj-1"
            session={null}
            cells={[cell]}
          />
        </>
      )
    }

    const user = userEvent.setup()
    renderWithTooltips(<Harness />)
    expect(screen.queryByTestId("new-voice-modal")).toBeNull()

    await user.click(screen.getByRole("button", { name: /clone/i }))

    const modal = screen.getByTestId("new-voice-modal")
    expect(modal.getAttribute("data-mode")).toBe("clone")
    expect(modal.getAttribute("data-seed")).toBe("cell-1")
  })
})
