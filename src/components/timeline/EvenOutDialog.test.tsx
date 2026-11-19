// AQU-2664 (board 71): the one Even out window — its three scopes, the target
// with its (i), the run with its progress and Cancel, Clear, and the
// weak-hardware fallback that says how many takes were skipped.
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { EvenOutDialog } from "./EvenOutDialog"
import type { EvenOutScope } from "@/lib/audio/even-out-scopes"
import type { EvenOutResult, TakeRef } from "@/lib/audio/even-out"

const refs = (n: number, p = "a"): TakeRef[] => Array.from({ length: n }, (_, i) => ({ cellId: `c${i}`, audioId: `${p}${i}` }))
const FILE: EvenOutScope = { pick: "file", names: [], trackCount: 5, takes: refs(212), evened: [] }
const TRACK: EvenOutScope = { pick: "track", names: ["Jesus"], trackCount: 1, takes: refs(93), evened: [] }
const SEL: EvenOutScope = { pick: "sel", names: ["Jesus", "Simon", "Narrator"], trackCount: 3, takes: refs(179), evened: [] }

const result = (over: Partial<EvenOutResult> = {}): EvenOutResult => ({
  targetLufs: -16, evened: 0, skipped: 0, unmeasured: 0, silent: 0, gone: 0, held: [], failed: 0, stepId: "s1", ...over,
})

function setup(over: Partial<Parameters<typeof EvenOutDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    scopes: [FILE, TRACK, SEL],
    start: "file" as const,
    run: vi.fn(async () => result({ evened: 212 })),
    clear: vi.fn(async () => ({ cleared: 0, gone: 0, failed: 0, stepId: "s2" })),
    onRan: vi.fn(),
    onCleared: vi.fn(),
    ...over,
  }
  render(<EvenOutDialog {...props} />)
  return props
}

describe("the Even out window", () => {
  it("has the title, the line under it, and the three scopes with their counts", () => {
    setup()
    expect(screen.getByRole("dialog", { name: "Even out loudness" })).toBeInTheDocument()
    expect(screen.getByText("Sets every take to the same loudness. The recordings don’t change.")).toBeInTheDocument()
    const group = screen.getByRole("radiogroup", { name: "Which takes" })
    expect(group).toHaveTextContent("The whole file")
    expect(group).toHaveTextContent("5 tracks · 212 takes")
    expect(group).toHaveTextContent("Jesus")
    expect(group).toHaveTextContent("93 takes")
    expect(group).toHaveTextContent("3 selected tracks")
    expect(group).toHaveTextContent("Jesus, Simon, Narrator · 179 takes")
  })

  it("starts on the scope it was opened from, and the button counts that scope", () => {
    setup({ start: "track", scopes: [FILE, TRACK] })
    expect(screen.getByRole("radio", { name: /Jesus/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("button", { name: "Even out 93 takes" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: /The whole file/ }))
    expect(screen.getByRole("button", { name: "Even out 212 takes" })).toBeInTheDocument()
  })

  it("says the target, and its (i) opens the explanation in place", () => {
    setup()
    expect(screen.getByText("Every take plays at")).toBeInTheDocument()
    expect(screen.getByText("−16 LUFS")).toBeInTheDocument()
    const info = screen.getByRole("button", { name: "About this loudness" })
    expect(info).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("even-out-target-info")).toHaveAttribute("data-open", "true")
    expect(screen.getByTestId("even-out-target-info")).toHaveTextContent(/raised at most 12 dB/)
  })

  it("shows Clear only when the scope has evened takes, and clears just those", async () => {
    const evenedTrack = { ...TRACK, evened: refs(93) }
    const p = setup({ start: "track", scopes: [FILE, evenedTrack] })
    expect(screen.getByRole("button", { name: "Clear 93" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: /The whole file/ }))
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull()
    fireEvent.click(screen.getByRole("radio", { name: /Jesus/ }))
    fireEvent.click(screen.getByRole("button", { name: "Clear 93" }))
    await waitFor(() => expect(p.clear).toHaveBeenCalledWith(evenedTrack.evened))
    await waitFor(() => expect(p.onCleared).toHaveBeenCalled())
    expect(vi.mocked(p.onCleared).mock.calls[0][1]).toBe(evenedTrack)
    expect(p.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("runs on the chosen scope's takes, shows its progress, and closes when done", async () => {
    let progress: ((done: number, total: number) => void) | undefined
    let finish: (r: EvenOutResult) => void = () => {}
    const run = vi.fn((_takes: readonly TakeRef[], opts: { onProgress?: (d: number, t: number) => void }) => {
      progress = opts.onProgress
      return new Promise<EvenOutResult>((resolve) => { finish = resolve })
    })
    const p = setup({ run })
    fireEvent.click(screen.getByRole("button", { name: "Even out 212 takes" }))
    expect(run.mock.calls[0][0]).toBe(FILE.takes)
    // 71 already measured: they count as done, and are not measured again.
    act(() => progress?.(70, 141))
    expect(screen.getByText("Measuring 141 of 212 takes…")).toBeInTheDocument()
    expect(screen.getByTestId("even-out-progress").style.width).toBe("67%")
    await act(async () => finish(result({ evened: 212 })))
    expect(p.onRan).toHaveBeenCalledWith(expect.objectContaining({ evened: 212 }), FILE)
    expect(p.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("Cancel stops the measuring and keeps what is done", async () => {
    let signal: AbortSignal | undefined
    const run = vi.fn((_t: readonly TakeRef[], opts: { signal?: AbortSignal }) => {
      signal = opts.signal
      return new Promise<EvenOutResult>((resolve) => opts.signal?.addEventListener("abort", () => resolve(result({ evened: 40, unmeasured: 0 }))))
    })
    const p = setup({ run })
    fireEvent.click(screen.getByRole("button", { name: "Even out 212 takes" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(p.onRan).toHaveBeenCalledWith(expect.objectContaining({ evened: 40 }), FILE))
  })

  it("never blocks the editor: no dimmer, and the page stays clickable", () => {
    setup()
    expect(document.querySelector("[data-slot=dialog-overlay]")).toBeNull()
  })

  it("weak hardware: stays open and says how many takes were skipped", async () => {
    const p = setup({ run: vi.fn(async () => result({ evened: 200, unmeasured: 12, skipped: 12 })) })
    fireEvent.click(screen.getByRole("button", { name: "Even out 212 takes" }))
    expect(await screen.findByText("12 takes couldn’t be measured on this device and were skipped. They play at their own volume.")).toBeInTheDocument()
    expect(p.onOpenChange).not.toHaveBeenCalledWith(false)
    expect(p.onRan).toHaveBeenCalled()
    // One button in the footer now, Close (beside the window's own ×).
    expect(screen.getByTestId("even-out-close")).toHaveTextContent("Close")
    expect(screen.queryByRole("button", { name: /^Even out/ })).toBeNull()
  })

  it("says so when the person may not even takes out", async () => {
    setup({ run: vi.fn(async () => result({ notAllowed: true })) })
    fireEvent.click(screen.getByRole("button", { name: "Even out 212 takes" }))
    expect(await screen.findByText("You can’t even out takes in this project.")).toBeInTheDocument()
  })
})
