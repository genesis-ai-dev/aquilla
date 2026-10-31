// AQU-2327: the Station's heading, its empty state, and its Approve and Undo.
import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetStationTargetForTests, openInStation } from "@/lib/station/target"
import { StationHeader, StationPanel, approvalState, versionKinds, versionOf } from "./StationPanel"
import type { StationHost, StationTake } from "./station-host"

vi.mock("@/lib/station/load", () => ({
  loadStationPcm: () => new Promise(() => {}),
  pcmKey: (u: string) => u,
}))

function makeTake(over: Partial<StationTake["att"]> = {}): StationTake {
  const att = { url: "frontier-audio://t2.webm", type: "audio", label: "Take 2", validators: [], validatorCount: 0, ...over }
  return {
    fileId: "f1",
    cell: { id: "c331", castName: "JESUS", attachments: { "t2.webm": att } } as unknown as StationTake["cell"],
    att: att as StationTake["att"],
  }
}

function makeHost(take: StationTake | null, over: Partial<StationHost> = {}): StationHost {
  return {
    project: { id: "p1" } as StationHost["project"],
    username: "ana",
    editable: true,
    getSyncToken: async () => "jwt",
    readTake: () => take,
    lineName: () => "line 331",
    trackVars: () => ({ "--tl-track-hue": "#2489eb" }),
    voteState: () => ({ canVote: true, voted: false }),
    vote: vi.fn(async () => {}),
    trim: vi.fn(async () => {}),
    approvalsNeeded: 1,
    pauseOtherPlayback: () => {},
    reportHistory: () => {},
    setLevel: vi.fn(async () => {}),
    selectedIn: () => null,
    fileName: () => null,
    insertChoices: () => [],
    placementsOf: () => (take ? [take] : []),
    removeNoise: async () => null,
    changeVoice: () => null,
    recordInsert: async () => null,
    ...over,
  }
}

describe("the Station", () => {
  afterEach(() => __resetStationTargetForTests())

  it("with nothing open, says how to open something", () => {
    render(<StationPanel host={makeHost(null)} visible />)
    expect(screen.getByTestId("station-empty").textContent).toMatch(/Edit in the Station/)
  })

  it("names the take and its line, its character, where it is placed and that it waits", () => {
    const take = makeTake()
    render(<StationHeader host={makeHost(take)} take={take} target={{ fileId: "f1", cellId: "c331", audioId: "t2.webm" }} />)
    expect(screen.getByText("Take 2 · line 331")).toBeTruthy()
    const sub = screen.getByTestId("station-subline").textContent ?? ""
    expect(sub).toContain("JESUS")
    expect(sub).toContain("Placed on line 331")
    expect(sub).toContain("◷ Waiting")
  })

  it("Approve votes on the take, and an approved take shows no button", () => {
    const take = makeTake()
    const host = makeHost(take)
    const target = { fileId: "f1", cellId: "c331", audioId: "t2.webm" }
    const { unmount } = render(<StationHeader host={host} take={take} target={target} />)
    fireEvent.click(screen.getByTestId("station-approve"))
    expect(host.vote).toHaveBeenCalledWith("c331", "t2.webm", true)
    unmount()
    const done = makeTake({ validators: ["rita"], validatorCount: 1 })
    render(<StationHeader host={makeHost(done)} take={done} target={target} />)
    expect(screen.queryByTestId("station-approve")).toBeNull()
    expect(screen.getByTestId("station-status").textContent).toContain("Approved")
  })

  it("Undo is greyed with nothing of this recording's to undo", () => {
    const take = makeTake()
    render(<StationHeader host={makeHost(take)} take={take} target={{ fileId: "f1", cellId: "c331", audioId: "t2.webm" }} />)
    expect(screen.getByTestId("station-undo").getAttribute("aria-disabled")).toBe("true")
  })

  it("opens on the take the store names, and shows its heading", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    render(<StationPanel host={makeHost(take)} visible />)
    expect(screen.getByTestId("station-header")).toBeTruthy()
  })

  it("opens the source recording to listen only, and says why (Q10)", () => {
    const src = makeTake({ role: "source" } as never)
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    render(<StationPanel host={makeHost(src)} visible />)
    expect(screen.getByTestId("station-source-note").textContent).toMatch(/source recording/)
    // Named as the source, never "Take", and with no approval status (it is
    // never approved): found in the browser walk.
    expect(screen.getByText("Source recording · line 331")).toBeTruthy()
    expect(screen.queryByTestId("station-status")).toBeNull()
    expect(screen.queryByTestId("station-approve")).toBeNull()
  })

  it("picking a listening speed closes its menu", async () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    render(<StationPanel host={makeHost(take)} visible />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId("station-speed"))
    await user.click(await screen.findByRole("menuitemradio", { name: "1.5×" }))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(screen.getByTestId("station-speed").textContent).toBe("1.5× ▾")
  })

  it("names a version's kinds of change each once, in the order they happened (item 30)", () => {
    expect(versionKinds([{ kind: "ins", at: 1, src: "x", len: 0.5, label: "p" }, { kind: "del", a: 0, b: 0.2 }, { kind: "ins", at: 2, src: "y", len: 0.5, label: "q" }])).toEqual(["inserted", "deleted"])
  })

  it("counts approvals against the project's need, and versions by the chain", () => {
    expect(approvalState(makeTake({ validatorCount: 1 }).att, 2)).toEqual({ approved: false, count: 1 })
    const v2 = makeTake({ referenceAudioId: "t1.webm" })
    ;(v2.cell.attachments as Record<string, unknown>)["t1.webm"] = { url: "x", type: "audio" }
    expect(versionOf(v2)).toBe(2)
  })
})
