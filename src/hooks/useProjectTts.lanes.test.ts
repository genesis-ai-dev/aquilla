// AQU-2037 — the hook is where a voice GETS its lane and where every voice
// read is narrowed to the open one. Separate file so the lane rules read on
// their own, next to the OmniVoice/rollback suites in useProjectTts.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))
vi.mock("@/lib/store/project-index", () => ({ patchProject: vi.fn(async () => {}) }))

import { useProjectTts } from "./useProjectTts"
import { loadProjectTts } from "@/lib/store/project-tts-store"
import { PRESET_VOICES } from "@/lib/audio/voices"

const PROJECT = "proj-voice-lanes"
const LANE_A = "lane-samoan"
const LANE_B = "lane-arabic"
const narrator = PRESET_VOICES[0]

function server(over: Partial<ProjectTtsSettings> = {}): ProjectTtsSettings {
  return {
    provider: "inworld",
    voices: [
      narrator,
      { id: "v-sam", name: "Samoan reader", laneId: LANE_A },
      { id: "v-ara", name: "LITTLE MARY MAGDALENE.", laneId: LANE_B },
    ],
    defaultVoiceId: narrator.id,
    ...over,
  }
}

function render(settings: ProjectTtsSettings | undefined, laneId: string | null) {
  return renderHook(() => useProjectTts(PROJECT, settings, [], undefined, "smo", laneId))
}

describe("useProjectTts lane scoping (AQU-2037)", () => {
  beforeEach(() => localStorage.clear())

  it("offers only the active lane's voices, and the whole library to writers", () => {
    const { result } = render(server(), LANE_B)
    expect(result.current.voices.map((v) => v.id)).toEqual([narrator.id, "v-ara"])
    expect(result.current.allVoices.map((v) => v.id)).toEqual([narrator.id, "v-sam", "v-ara"])
    expect(result.current.settings?.voices?.map((v) => v.id)).toEqual([narrator.id, "v-sam", "v-ara"])
  })

  it("resolves the lane's default to the Narrator when the starred one belongs elsewhere", () => {
    const { result } = render(server({ defaultVoiceId: "v-sam" }), LANE_B)
    expect(result.current.defaultVoiceId).toBe(narrator.id)
    expect(result.current.laneSettings?.defaultVoiceId).toBe(narrator.id)
    // The project's own starred default is untouched — AQU-2041 owns the
    // per-lane default; this slice only stops a lane speaking with it.
    expect(result.current.settings?.defaultVoiceId).toBe("v-sam")
  })

  it("hides a cast assignment that points at another lane's voice", () => {
    const { result } = render(
      server({ castAssignments: { "cell-1": "v-ara", "cell-2": "v-sam" } }),
      LANE_A,
    )
    expect(result.current.laneSettings?.castAssignments).toEqual({ "cell-2": "v-sam" })
    // Still whole for the write path: assigning on one lane must not drop the
    // other lane's assignments.
    expect(result.current.settings?.castAssignments).toEqual({ "cell-1": "v-ara", "cell-2": "v-sam" })
  })

  it("stamps a newly stored voice with the active lane", async () => {
    const { result } = render(server(), LANE_A)
    await act(async () => {
      await result.current.saveTts({
        voices: [...result.current.allVoices, { id: "v-new", name: "New voice" }],
      })
    })
    const stored = result.current.settings?.voices ?? []
    expect(stored.find((v) => v.id === "v-new")?.laneId).toBe(LANE_A)
    // Nothing already stored moves lane, and the Narrator stays lane-less.
    expect(stored.find((v) => v.id === "v-ara")?.laneId).toBe(LANE_B)
    expect(stored.find((v) => v.id === narrator.id)?.laneId).toBeUndefined()
  })

  it("persists the lane through the durable store and back out as the lane view", async () => {
    // AGENTS.md rule 12: the real producer's output through its immediate
    // consumer. `saveTts` writes the stamped library to the localStorage copy
    // a reload reads FIRST, so the lane has to survive that round trip or a
    // refresh would hand every lane the voice back.
    const { result } = render(server(), LANE_A)
    await act(async () => {
      await result.current.saveTts({
        voices: [...result.current.allVoices, { id: "v-new", name: "New voice" }],
      })
    })
    expect(loadProjectTts(PROJECT)?.voices?.find((v) => v.id === "v-new")?.laneId).toBe(LANE_A)

    const reloaded = renderHook(
      ({ laneId }: { laneId: string }) =>
        useProjectTts(PROJECT, server(), [], undefined, "smo", laneId),
      { initialProps: { laneId: LANE_B } },
    )
    expect(reloaded.result.current.voices.map((v) => v.id)).toEqual([narrator.id, "v-ara"])
    reloaded.rerender({ laneId: LANE_A })
    expect(reloaded.result.current.voices.map((v) => v.id)).toEqual([narrator.id, "v-sam", "v-new"])
  })

  it("does not move a voice to the lane it is edited from", async () => {
    const { result } = render(server(), LANE_A)
    await act(async () => {
      await result.current.saveTts({
        voices: result.current.allVoices.map((v) =>
          v.id === "v-ara" ? { ...v, name: "Renamed on lane A" } : v,
        ),
      })
    })
    expect(result.current.settings?.voices?.find((v) => v.id === "v-ara")?.laneId).toBe(LANE_B)
  })

  it("gives a lane with no voices of its own just the built-in Narrator", () => {
    const elsewhere = server({ voices: [{ id: "v-sam", name: "Samoan reader", laneId: LANE_A }] })
    const { result } = render(elsewhere, "lane-fresh")
    expect(result.current.voices).toEqual([...PRESET_VOICES])
    expect(result.current.defaultVoiceId).toBe(narrator.id)
  })

  it("changes nothing on a project with no target lane rows", async () => {
    const whole = server()
    const { result } = render(whole, null)
    expect(result.current.laneSettings).toBe(result.current.settings)
    expect(result.current.voices.map((v) => v.id)).toEqual([narrator.id, "v-sam", "v-ara"])
    await act(async () => {
      await result.current.saveTts({
        voices: [...result.current.allVoices, { id: "v-new", name: "New voice" }],
      })
    })
    expect(result.current.settings?.voices?.find((v) => v.id === "v-new")?.laneId).toBeUndefined()
  })

  it("re-scopes without a reload when the Target dropdown moves", () => {
    const { result, rerender } = renderHook(
      ({ laneId }: { laneId: string }) =>
        useProjectTts(PROJECT, server(), [], undefined, "smo", laneId),
      { initialProps: { laneId: LANE_A } },
    )
    expect(result.current.voices.map((v) => v.id)).toEqual([narrator.id, "v-sam"])
    rerender({ laneId: LANE_B })
    expect(result.current.voices.map((v) => v.id)).toEqual([narrator.id, "v-ara"])
  })
})
