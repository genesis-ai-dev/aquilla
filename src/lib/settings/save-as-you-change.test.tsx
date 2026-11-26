// AQU-2262: settings save as you change them. A typing field saves when you
// leave it or after a short pause — never on every keystroke, never with a
// half-typed value — and each setting says "Saved" quietly beside itself.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, renderHook, screen } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { useCommitOnPause, numberField } from "./useCommitOnPause"
import { SaveStatus, SaveStatusProvider, useSaveTracker } from "./save-status"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const type = (field: { onChange: (e: { target: { value: string } }) => void }, text: string) =>
  act(() => field.onChange({ target: { value: text } }))

describe("a typing field", () => {
  it("does not save while you type; it saves the whole value once you pause", () => {
    const commit = vi.fn()
    const { result } = renderHook(() =>
      useCommitOnPause({ value: "Ruth", toText: (v) => v, parse: (t) => t.trim() || null, commit }),
    )
    type(result.current, "Ruth ")
    type(result.current, "Ruth d")
    type(result.current, "Ruth draft")
    expect(commit).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1500))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith("Ruth draft", { from: "Ruth", final: false })
  })

  it("saves when you leave it, as one change from where you started", () => {
    const commit = vi.fn()
    const { result } = renderHook(() =>
      useCommitOnPause({ value: "Ruth", toText: (v) => v, parse: (t) => t.trim() || null, commit }),
    )
    type(result.current, "Ruth 2")
    act(() => result.current.onBlur())
    expect(commit).toHaveBeenCalledWith("Ruth 2", { from: "Ruth", final: true })
    act(() => vi.advanceTimersByTime(5000))
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it("after a pause has saved, leaving the field ends the change without writing again", () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(({ value }) =>
      useCommitOnPause({ value, toText: (v) => v, parse: (t) => t.trim() || null, commit }),
    { initialProps: { value: "Ruth" } })
    type(result.current, "Ruth 2")
    act(() => vi.advanceTimersByTime(1500))
    rerender({ value: "Ruth 2" }) // the saved value now
    act(() => result.current.onBlur())
    expect(commit).toHaveBeenLastCalledWith("Ruth 2", { from: "Ruth", final: true })
  })

  it("a value that is not whole yet is never saved, and leaving puts the saved one back", () => {
    const commit = vi.fn()
    const { result } = renderHook(() =>
      useCommitOnPause({ value: "Ruth", toText: (v) => v, parse: (t) => t.trim() || null, commit }),
    )
    type(result.current, "   ")
    act(() => vi.advanceTimersByTime(1500))
    act(() => result.current.onBlur())
    expect(commit).not.toHaveBeenCalled()
    expect(result.current.value).toBe("Ruth")
  })

  it("a number out of range while typing waits; on leaving it is brought into range", () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCommitOnPause({ value: 5, ...numberField({ min: 1, max: 20 }), commit }))
    type(result.current, "200")
    act(() => vi.advanceTimersByTime(1500))
    expect(commit).not.toHaveBeenCalled()
    act(() => result.current.onBlur())
    expect(commit).toHaveBeenCalledWith(20, { from: 5, final: true })
  })

  it("shows the saved value as it changes elsewhere while you are not typing in it", () => {
    const { result, rerender } = renderHook(({ value }) =>
      useCommitOnPause({ value, toText: (v) => v, parse: (t) => t || null, commit: vi.fn() }),
    { initialProps: { value: "Ruth" } })
    rerender({ value: "Ruth (team copy)" })
    expect(result.current.value).toBe("Ruth (team copy)")
  })
})

function Probe({ run }: { run: () => Promise<{ kind: "saved" } | { kind: "theirs"; name: string | null }> }) {
  const track = useSaveTracker()
  return (
    <>
      <button onClick={() => track("smartQuotes", run)}>change</button>
      <SaveStatus id="smartQuotes" />
    </>
  )
}

// A saved value that only catches up after the write (a project name is
// re-read once the rename lands) used to show the OLD text from the moment
// the field was left until then.
describe("a typing field whose save takes a moment", () => {
  const field = (value: string, commit: (next: string) => Promise<{ kind: string }>) =>
    renderHook(
      ({ value: v }) => useCommitOnPause({ value: v, toText: (x) => x, parse: (t) => t.trim() || null, commit }),
      { initialProps: { value } },
    )

  it("keeps showing what was typed until the saved value catches up", async () => {
    let answer!: (result: { kind: string }) => void
    const { result, rerender } = field("Ruth", () => new Promise((resolve) => { answer = resolve }))
    type(result.current, "Ruth 2")
    act(() => result.current.onBlur())
    expect(result.current.value).toBe("Ruth 2")

    await act(async () => answer({ kind: "saved" }))
    // Saved, but the page has not re-read the name yet.
    expect(result.current.value).toBe("Ruth 2")

    rerender({ value: "Ruth 2" })
    expect(result.current.value).toBe("Ruth 2")
    // From here the field follows the saved value again.
    rerender({ value: "Ruth 3" })
    expect(result.current.value).toBe("Ruth 3")
  })

  it("shows the saved value again when the save fails", async () => {
    const { result } = field("Ruth", async () => ({ kind: "failed" }))
    type(result.current, "Ruth 2")
    await act(async () => result.current.onBlur())
    expect(result.current.value).toBe("Ruth")
  })
})

describe("the quiet Saved", () => {
  it("appears beside the setting once it has saved, then fades", async () => {
    render(
      <I18nProvider>
        <SaveStatusProvider>
          <Probe run={async () => ({ kind: "saved" })} />
        </SaveStatusProvider>
      </I18nProvider>,
    )
    await act(async () => screen.getByText("change").click())
    expect(screen.getByRole("status")).toHaveTextContent("Saved")
    act(() => vi.advanceTimersByTime(4000))
    expect(screen.queryByText("Saved")).toBeNull()
  })

  it("says plainly when someone else's change won, and keeps saying it", async () => {
    render(
      <I18nProvider>
        <SaveStatusProvider>
          <Probe run={async () => ({ kind: "theirs", name: "alex" })} />
        </SaveStatusProvider>
      </I18nProvider>,
    )
    await act(async () => screen.getByText("change").click())
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole("status")).toHaveTextContent("alex changed this first, so their change is kept.")
  })
})
