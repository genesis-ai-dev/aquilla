// AQU-2037 — the hook is where a voice GETS its lane and where every voice
// read is narrowed to the open one. Separate file so the lane rules read on
// their own, next to the OmniVoice/rollback suites in useProjectTts.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

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

// AQU-2038 — the cast and the starred default belong to the lane too, and sit
// ON TOP of AQU-2037's lane library. The hook names the lane twice: its row id
// says which voices it can see, its legacy tag keys its cast and default; and
// `laneSettings` answers for both at once, in that order.
describe("useProjectTts lane cast and default (AQU-2038)", () => {
  beforeEach(() => localStorage.clear())

  const TAG_A = "sm"
  const TAG_B = "ar"
  const sam: Voice = { id: "v-sam", name: "Samoan reader", laneId: LANE_A }
  const ara: Voice = { id: "v-ara", name: "LITTLE MARY MAGDALENE.", laneId: LANE_B }
  // Stored before lanes existed: no laneId, so every lane sees it (AQU-2037).
  const shared: Voice = { id: "v-old", name: "Pre-lane voice" }

  function renderLane(settings: ProjectTtsSettings, laneId: string | null, tag: string) {
    return renderHook(
      ({ laneId, tag }: { laneId: string | null; tag: string }) =>
        useProjectTts(PROJECT, settings, [], undefined, "smo", laneId, tag),
      { initialProps: { laneId, tag } },
    )
  }

  it("casts a cell on the active lane only, leaving the project-wide fallback for the others", async () => {
    const whole = server({ voices: [narrator, sam, ara, shared], castAssignments: { "cell-1": "v-old" } })
    const { result, rerender } = renderLane(whole, LANE_A, TAG_A)
    await act(async () => { result.current.assignCells(["cell-1"], "v-sam") })
    expect(result.current.laneSettings?.castAssignments?.["cell-1"]).toBe("v-sam")
    // The stored project-wide map is the fallback every other lane reads; a
    // lane's choice never rewrites it — it lands under the lane's own key.
    expect(result.current.settings?.castAssignments).toEqual({ "cell-1": "v-old" })
    expect(result.current.settings?.laneCastAssignments).toEqual({ [TAG_A]: { "cell-1": "v-sam" } })
    expect(loadProjectTts(PROJECT)?.laneCastAssignments).toEqual({ [TAG_A]: { "cell-1": "v-sam" } })
    rerender({ laneId: LANE_B, tag: TAG_B })
    expect(result.current.laneSettings?.castAssignments?.["cell-1"]).toBe("v-old")
  })

  it("sends a cell back to the lane's default over an inherited assignment, on this lane only", async () => {
    const whole = server({ voices: [narrator, sam, ara, shared], castAssignments: { "cell-1": "v-old" } })
    const { result, rerender } = renderLane(whole, LANE_A, TAG_A)
    await act(async () => { result.current.assignCells(["cell-1"], null) })
    expect(result.current.laneSettings?.castAssignments?.["cell-1"]).toBeUndefined()
    rerender({ laneId: LANE_B, tag: TAG_B })
    expect(result.current.laneSettings?.castAssignments?.["cell-1"]).toBe("v-old")
  })

  it("drops an inherited assignment naming a voice this lane cannot see", () => {
    // AGENTS.md rule 12: AQU-2037's lane library through AQU-2038's projection.
    // Lane A has its own cast, so the projection is live — and the inherited
    // "cell-1 → v-ara" must still not survive, because lane A has no v-ara.
    const whole = server({
      castAssignments: { "cell-1": "v-ara", "cell-2": "v-sam" },
      laneCastAssignments: { [TAG_A]: { "cell-3": "v-sam" } },
    })
    const { result } = renderLane(whole, LANE_A, TAG_A)
    expect(result.current.laneSettings?.castAssignments).toEqual({ "cell-2": "v-sam", "cell-3": "v-sam" })
  })

  it("stars a voice for the active lane only; the project-wide default stays the fallback", async () => {
    const { result, rerender } = renderLane(server(), LANE_A, TAG_A)
    await act(async () => { await result.current.saveTts({ defaultVoiceId: "v-sam" }) })
    expect(result.current.defaultVoiceId).toBe("v-sam")
    expect(result.current.laneSettings?.defaultVoiceId).toBe("v-sam")
    expect(result.current.settings?.defaultVoiceId).toBe(narrator.id)
    expect(loadProjectTts(PROJECT)?.laneDefaultVoiceId).toEqual({ [TAG_A]: "v-sam" })
    rerender({ laneId: LANE_B, tag: TAG_B })
    expect(result.current.defaultVoiceId).toBe(narrator.id)
    expect(result.current.laneSettings?.defaultVoiceId).toBe(narrator.id)
  })

  it("keeps the lane's star through a voice save that passes the lane's default along", async () => {
    // What the clone host and the Voices panel send with every voice write
    // (`upsertVoice`): the default they were shown. It has to be the lane's
    // own — the project-wide one would move the star — so this pins the
    // pattern end to end, stamping included.
    const { result } = renderLane(server(), LANE_A, TAG_A)
    await act(async () => { await result.current.saveTts({ defaultVoiceId: "v-sam" }) })
    await act(async () => {
      await result.current.saveTts({
        voices: [...result.current.allVoices, { id: "v-new", name: "New voice" }],
        defaultVoiceId: result.current.laneSettings?.defaultVoiceId,
      })
    })
    expect(result.current.defaultVoiceId).toBe("v-sam")
    expect(result.current.settings?.defaultVoiceId).toBe(narrator.id)
    expect(result.current.settings?.voices?.find((v) => v.id === "v-new")?.laneId).toBe(LANE_A)
  })

  it("still casts under the default lane on a project with no target lane rows", async () => {
    const { result } = renderLane(server(), null, "")
    await act(async () => { result.current.assignCells(["cell-1"], "v-ara") })
    expect(result.current.laneSettings?.castAssignments?.["cell-1"]).toBe("v-ara")
    expect(result.current.settings?.castAssignments).toBeUndefined()
    expect(result.current.settings?.laneCastAssignments).toEqual({ "": { "cell-1": "v-ara" } })
  })
})
