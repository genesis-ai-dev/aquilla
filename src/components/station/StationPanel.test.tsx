// AQU-2327: the Station's heading, its empty state, and its Undo, Save and Approve.
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetStationTargetForTests, getStationTarget, openInStation } from "@/lib/station/target"
import { StationSave } from "./StationEdits"
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

  it("an unsaved change shows as text under the name and Save sits between Undo and Approve, with no banner (Nov 2)", () => {
    const take = makeTake()
    const onSave = vi.fn()
    render(
      <StationHeader
        host={makeHost(take)}
        take={take}
        target={{ fileId: "f1", cellId: "c331", audioId: "t2.webm" }}
        unsaved
        notSaved="a part deleted, audio inserted"
        save={<StationSave places={["line 331"]} openLine="line 331" saving={false} onSave={onSave} menuOpen={false} onMenuOpen={() => {}} />}
      />,
    )
    expect(screen.getByTestId("station-not-saved").textContent).toBe("Not saved: a part deleted, audio inserted")
    expect(screen.queryByTestId("station-notice")).toBeNull()
    const order = [...screen.getByTestId("station-header").querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"))
    expect(order.filter((id) => ["station-undo", "station-save", "station-approve"].includes(id ?? ""))).toEqual(["station-undo", "station-save", "station-approve"])
    // One click saves over the take (Nov 2).
    fireEvent.click(screen.getByTestId("station-save"))
    expect(onSave).toHaveBeenCalledWith({ mode: "over", scope: "all" })
  })

  it("Save's ▾ saves a new version instead; placed on two lines, on this clip only or everywhere", async () => {
    const onSave = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(false)
      return <StationSave places={["line 9", "line 12"]} openLine="line 9" saving={false} onSave={onSave} menuOpen={open} onMenuOpen={setOpen} />
    }
    render(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId("station-save-more"))
    expect((await screen.findByTestId("station-save-over")).textContent).toContain("Save over this take")
    expect(screen.getByText("Save as new version")).toBeTruthy()
    expect(screen.getByTestId("station-scope-clip").textContent).toBe("For this clip only · line 9")
    expect(screen.getByTestId("station-scope-all").textContent).toBe("Everywhere · 2 places")
    await user.click(screen.getByTestId("station-scope-all"))
    expect(onSave).toHaveBeenCalledWith({ mode: "new", scope: "all" })
  })

  it("an (i) beside the name opens how the controls work, in place, and closes it again (Nov 2)", () => {
    const take = makeTake()
    render(<StationHeader host={makeHost(take)} take={take} target={{ fileId: "f1", cellId: "c331", audioId: "t2.webm" }} controlsInfo />)
    const info = screen.getByTestId("station-info")
    const help = screen.getByTestId("station-controls-info")
    expect(help.getAttribute("data-open")).toBe("false")
    fireEvent.click(info)
    expect(help.getAttribute("data-open")).toBe("true")
    expect(help.textContent).toContain("Drag the round knob at a top corner inward")
    expect(help.textContent).toContain("Space plays")
    // Saving says what Save does now (found in the Nov 2 browser check: it
    // still said edits wait for Save as new version, and the original is
    // always kept).
    expect(help.textContent).toContain("Save saves over the take")
    expect(help.textContent).toContain("Save's ▾ saves a new version")
    expect(help.textContent).not.toContain("always kept")
    fireEvent.click(info)
    expect(help.getAttribute("data-open")).toBe("false")
  })

  it("keeps its keys from the timeline, and leaves Space to a focused button (Nov 2 shortcut review)", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    render(<StationPanel host={makeHost(take)} visible />)
    const onWindow = vi.fn()
    window.addEventListener("keydown", onWindow)
    try {
      // S and B are the timeline's split and blade: they stop at the Station.
      expect(fireEvent.keyDown(screen.getByTestId("station"), { key: "s", code: "KeyS" })).toBe(false)
      expect(fireEvent.keyDown(screen.getByTestId("station"), { key: "b", code: "KeyB" })).toBe(false)
      expect(onWindow).not.toHaveBeenCalled()
      // Space on a focused button is the button's.
      expect(fireEvent.keyDown(screen.getByTestId("station-undo"), { key: " ", code: "Space" })).toBe(true)
      // A Russian layout types "л" on the L key: it still loops.
      expect(fireEvent.keyDown(screen.getByTestId("station"), { key: "л", code: "KeyL" })).toBe(false)
      // AltGr+S (Polish ś) arrives as Ctrl+Alt+S: it isn't Save, and stays the page's.
      expect(fireEvent.keyDown(screen.getByTestId("station"), { key: "ś", code: "KeyS", ctrlKey: true, altKey: true })).toBe(true)
      // ⌘Enter stops at the Station: the timeline would rewind.
      expect(fireEvent.keyDown(screen.getByTestId("station"), { key: "Enter", code: "Enter", metaKey: true })).toBe(false)
    } finally {
      window.removeEventListener("keydown", onWindow)
    }
  })

  // Found in the Nov 2 browser check: Undo of a Save took the saved take away
  // and brought back the one it was made from, but the Station said "This
  // recording is no longer here."
  it("when Undo takes a saved take away, it opens the take it was made from again", () => {
    const orig = makeTake()
    const savedAtt = { url: "frontier-audio://v.wav", type: "audio", label: "Take 2", validators: [], validatorCount: 0, referenceAudioId: "t2.webm" }
    const cell = { id: "c331", castName: "JESUS", attachments: { "t2.webm": orig.att, "v.wav": savedAtt } } as unknown as StationTake["cell"]
    let savedGone = false
    let origGone = true
    const readTake = (_cellId: string, audioId: string): StationTake | null =>
      audioId === "v.wav" && !savedGone
        ? { fileId: "f1", cell, att: savedAtt as StationTake["att"] }
        : audioId === "t2.webm" && !origGone
          ? { fileId: "f1", cell, att: orig.att }
          : null
    openInStation({ fileId: "f1", cellId: "c331", audioId: "v.wav" })
    const { rerender } = render(<StationPanel host={makeHost(null, { readTake })} visible />)
    expect(screen.getByText("Take 2 · line 331")).toBeTruthy()
    // Undo: the saved take goes, and the take it was saved over comes back.
    savedGone = true
    origGone = false
    act(() => rerender(<StationPanel host={makeHost(null, { readTake })} visible />))
    expect(getStationTarget()?.audioId).toBe("t2.webm")
    expect(screen.queryByTestId("station-note")).toBeNull()
    expect(screen.getByText("Take 2 · line 331")).toBeTruthy()
  })

  it("when a take and the one it was made from are both gone, it says so", () => {
    const savedAtt = { url: "frontier-audio://v.wav", type: "audio", label: "Take 2", validators: [], validatorCount: 0, referenceAudioId: "t2.webm" }
    const cell = { id: "c331", attachments: { "v.wav": savedAtt } } as unknown as StationTake["cell"]
    let gone = false
    const readTake = (_c: string, audioId: string): StationTake | null => (audioId === "v.wav" && !gone ? { fileId: "f1", cell, att: savedAtt as StationTake["att"] } : null)
    openInStation({ fileId: "f1", cellId: "c331", audioId: "v.wav" })
    const { rerender } = render(<StationPanel host={makeHost(null, { readTake })} visible />)
    gone = true
    act(() => rerender(<StationPanel host={makeHost(null, { readTake })} visible />))
    expect(getStationTarget()?.audioId).toBe("v.wav")
    expect(screen.getByTestId("station-note").textContent).toMatch(/no longer here/)
  })

  // Found in the Nov 2 browser check: after Insert › Record now (or Stop,
  // Keep, Record again) the button pressed went away and the focus with it,
  // so Space and Esc no longer stopped the recording.
  it("keeps the focus in the Station when a button pressed in it goes away", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" }, { message: "Saved over Take 2 on line 331." })
    render(<StationPanel host={makeHost(take)} visible />)
    const close = within(screen.getByTestId("station-message")).getByRole("button")
    close.focus()
    fireEvent.click(close)
    expect(screen.queryByTestId("station-message")).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId("station"))
  })

  // Found in the Nov 2 browser re-check: Stop is disabled while the recording
  // finishes, which drops the focus without removing the button (React then
  // reuses it as Keep), so Enter didn't keep the new recording.
  it("takes the focus back when a control in it loses the focus to nothing, though it is still there", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    const { rerender } = render(<StationPanel host={makeHost(take)} visible />)
    const undo = screen.getByTestId("station-undo")
    undo.focus()
    undo.blur()
    expect(document.activeElement).toBe(document.body)
    rerender(<StationPanel host={makeHost(take)} visible />)
    expect(document.activeElement).toBe(screen.getByTestId("station"))
  })

  it("leaves the focus alone after a press outside the Station", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    const { rerender } = render(<StationPanel host={makeHost(take)} visible />)
    const undo = screen.getByTestId("station-undo")
    undo.focus()
    fireEvent.pointerDown(document.body)
    undo.blur()
    rerender(<StationPanel host={makeHost(take)} visible />)
    expect(document.activeElement).toBe(document.body)
  })

  it("leaves the focus alone when you move it out of the Station", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    const outside = document.createElement("button")
    document.body.appendChild(outside)
    try {
      render(<StationPanel host={makeHost(take)} visible />)
      screen.getByTestId("station-undo").focus()
      outside.focus()
      fireEvent.click(screen.getByTestId("station-info"))
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it("opens on the take the store names, and shows its heading", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    render(<StationPanel host={makeHost(take)} visible />)
    expect(screen.getByTestId("station-header")).toBeTruthy()
  })

  it("keeps the hint's row laid out while the pointer is over the lane, so the lane never changes height (Nov 2)", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    render(<StationPanel host={makeHost(take)} visible />)
    const row = screen.getByTestId("station-status-row")
    const hint = within(row).getByText(/Drag across the waveform/)
    expect(hint.className).toContain("opacity-100")
    fireEvent.pointerEnter(screen.getByTestId("station-lane"))
    expect(within(row).getByText(/Drag across the waveform/)).toBe(hint)
    expect(hint.className).toContain("opacity-0")
  })

  // Found in the Nov 2 browser check: the row was 28 px at rest and 30 px
  // with Record now's line or the typing help in it (their 24 px buttons and
  // the row's 6 px under them), so the lane lost 2 px each time they showed.
  it("sizes the hint's row for the tallest line it holds, so the lane keeps its height when Record now's line shows", () => {
    const take = makeTake()
    openInStation({ fileId: "f1", cellId: "c331", audioId: "t2.webm" })
    render(<StationPanel host={makeHost(take)} visible />)
    const row = screen.getByTestId("station-status-row")
    expect(row.className).toMatch(/(^|\s)min-h-\[30px\](\s|$)/)
    expect(row.className).toMatch(/(^|\s)pb-1\.5(\s|$)/)
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
