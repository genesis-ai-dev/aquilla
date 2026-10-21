/**
 * AQU-2037 — the Voices roster lists and counts the ACTIVE LANE's voices.
 *
 * The panel owns the project's whole library (its writes carry all of it), so
 * these cover both halves: the lane narrows what is SHOWN, and a write still
 * carries every lane's voices.
 */

import { describe, it, expect, vi } from "vitest"
import { fireEvent, screen, within } from "@testing-library/react"
import { VoiceLibraryPanel } from "./VoiceLibraryPanel"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { PRESET_VOICES } from "@/lib/audio/voices"
import type { NewVoiceModalProps } from "@/components/voice/NewVoiceModal"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const modalProps: { last: NewVoiceModalProps | null } = { last: null }
vi.mock("@/components/voice/NewVoiceModal", () => ({
  NewVoiceModal: (props: NewVoiceModalProps) => {
    modalProps.last = props
    return props.open ? <div data-testid="new-voice-modal" /> : null
  },
}))

const LANE_A = "lane-samoan"
const LANE_B = "lane-arabic"
const narrator = PRESET_VOICES[0]
const samoan: Voice = { id: "v-sam", name: "Samoan reader", color: "#0e7490", laneId: LANE_A }
const arabic: Voice = { id: "v-ara", name: "Mary Magdalene", color: "#be123c", laneId: LANE_B }
const legacy: Voice = { id: "v-old", name: "Pre-2037", color: "#2563eb" }

function setup(laneId: string | null, voices: Voice[] = [narrator, samoan, arabic]) {
  const onSettingsChange = vi.fn()
  const settings: ProjectTtsSettings = { provider: "inworld", voices, defaultVoiceId: narrator.id }
  modalProps.last = null
  renderWithTooltips(
    <VoiceLibraryPanel
      projectId="dev-project"
      settings={settings}
      laneId={laneId}
      onSettingsChange={onSettingsChange}
    />,
  )
  return { onSettingsChange }
}

function headerCount(): string {
  const heading = screen.getByRole("heading", { name: "Voices" })
  return within(heading.parentElement as HTMLElement).getByText(/^\d+$/).textContent ?? ""
}

describe("VoiceLibraryPanel lane scoping (AQU-2037)", () => {
  it("lists the active lane's voices and counts them, not the project's", () => {
    setup(LANE_A)
    expect(screen.getByText("Samoan reader")).toBeTruthy()
    expect(screen.queryByText("Mary Magdalene")).toBeNull()
    expect(headerCount()).toBe("2")
  })

  it("lists the other lane's voices once the Target dropdown moves", () => {
    setup(LANE_B)
    expect(screen.getByText("Mary Magdalene")).toBeTruthy()
    expect(screen.queryByText("Samoan reader")).toBeNull()
    expect(headerCount()).toBe("2")
  })

  it("keeps showing a pre-2037 voice on every lane", () => {
    setup(LANE_B, [narrator, samoan, legacy])
    expect(screen.getByText("Pre-2037")).toBeTruthy()
    expect(screen.queryByText("Samoan reader")).toBeNull()
  })

  it("shows a lane with no voices of its own just the built-in Narrator", () => {
    setup("lane-fresh", [samoan, arabic])
    expect(screen.getByText(narrator.name)).toBeTruthy()
    expect(screen.queryByText("Samoan reader")).toBeNull()
    expect(headerCount()).toBe("1")
  })

  it("lists the whole library when the project has no target lane rows", () => {
    setup(null)
    expect(screen.getByText("Samoan reader")).toBeTruthy()
    expect(screen.getByText("Mary Magdalene")).toBeTruthy()
    expect(headerCount()).toBe("3")
  })

  it("search scans the lane's voices only", () => {
    setup(LANE_A)
    fireEvent.change(screen.getByPlaceholderText("Search voices…"), { target: { value: "mary" } })
    expect(screen.queryByText("Mary Magdalene")).toBeNull()
  })

  it("a write still carries every lane's voices — deleting on one lane leaves the other alone", () => {
    const { onSettingsChange } = setup(LANE_A)
    fireEvent.contextMenu(screen.getByText("Samoan reader"))
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }))
    expect(onSettingsChange).toHaveBeenCalledTimes(1)
    expect(onSettingsChange.mock.calls[0][0].voices.map((v: Voice) => v.id))
      .toEqual([narrator.id, arabic.id])
  })
})
