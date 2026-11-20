// AQU-2655: the workspace's debounced corpus used to be React state, so the
// debounce firing rendered the whole workspace 600 ms after every commit for
// data that only getters and effects read. `useDebouncedSource` must deliver
// the same debounced value WITHOUT rendering its host, and still let a
// consumer that shows a derived result (an open Back-translation tab) follow it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook } from "@testing-library/react"
import { useDebouncedSource, type DebouncedSource } from "./useDebouncedValue"
import { useChangeSignal, useChangeSignalVersion } from "./useStableCallback"

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe("useDebouncedSource", () => {
  it("lands the new value after the quiet period without rendering its host", () => {
    let hostRenders = 0
    const { result, rerender } = renderHook(
      ({ value }) => {
        hostRenders += 1
        return useDebouncedSource(value, 600)
      },
      { initialProps: { value: "a" } },
    )
    const source = result.current
    expect(source.get()).toBe("a")

    rerender({ value: "b" })
    const rendersAfterChange = hostRenders
    act(() => { vi.advanceTimersByTime(599) })
    expect(source.get()).toBe("a")

    const versionBefore = source.signal.getVersion()
    act(() => { vi.advanceTimersByTime(1) })
    expect(source.get()).toBe("b")
    expect(source.signal.getVersion()).toBe(versionBefore + 1)
    // The point of the hook: the debounce firing is not a host render.
    expect(hostRenders).toBe(rendersAfterChange)
    expect(result.current).toBe(source)
  })

  it("coalesces a burst into one change, the last value", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedSource(value, 600), { initialProps: { value: 0 } })
    const listener = vi.fn()
    result.current.signal.subscribe(listener)
    for (let i = 1; i <= 5; i++) {
      rerender({ value: i })
      act(() => { vi.advanceTimersByTime(100) })
    }
    expect(result.current.get()).toBe(0)
    act(() => { vi.advanceTimersByTime(600) })
    expect(result.current.get()).toBe(5)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("re-renders only the consumer that is showing a result derived from it", () => {
    // The EditorTable arrangement: getters read the source at call time, and a
    // row follows it through a change signal with the source as its upstream.
    let openRenders = 0
    let closedRenders = 0
    function Row({ source, open }: { source: DebouncedSource<string>; open: boolean }) {
      const signal = useChangeSignal([], source.signal)
      const version = useChangeSignalVersion(signal, open)
      if (open) openRenders += 1
      else closedRenders += 1
      return <span data-testid={open ? "open" : "closed"} data-version={version}>{open ? source.get() : ""}</span>
    }
    function Host({ value }: { value: string }) {
      const source = useDebouncedSource(value, 600)
      return (
        <>
          <Row source={source} open />
          <Row source={source} open={false} />
        </>
      )
    }
    const { rerender, getByTestId } = render(<Host value="a" />)
    rerender(<Host value="b" />)
    const open = openRenders
    const closed = closedRenders
    act(() => { vi.advanceTimersByTime(600) })
    expect(getByTestId("open").textContent).toBe("b")
    expect(openRenders).toBe(open + 1)
    expect(closedRenders).toBe(closed)
  })
})
