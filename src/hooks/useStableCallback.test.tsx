import { describe, it, expect, vi } from "vitest"
import { act, render, renderHook } from "@testing-library/react"
import { useMemo } from "react"
import { useChangeSignal, useChangeSignalVersion, useStableCallback, type ChangeSignal } from "./useStableCallback"
import { mapsEqual, useStableValue } from "./useStableValue"

describe("useStableCallback (AQU-2654)", () => {
  it("keeps one identity and runs the newest function", () => {
    const first = vi.fn((_arg: string) => "first")
    const second = vi.fn((_arg: string) => "second")
    const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), { initialProps: { fn: first } })
    const stable = result.current
    expect(stable("a")).toBe("first")

    rerender({ fn: second })
    expect(result.current).toBe(stable)
    expect(stable("b")).toBe("second")
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith("b")
  })

  it("stays undefined while the callback is, so `onX?.()` gates keep their meaning", () => {
    const fn = vi.fn()
    const { result, rerender } = renderHook(
      ({ handler }: { handler: (() => void) | undefined }) => useStableCallback(handler),
      { initialProps: { handler: undefined as (() => void) | undefined } },
    )
    expect(result.current).toBeUndefined()
    rerender({ handler: fn })
    expect(result.current).toBeTypeOf("function")
    rerender({ handler: undefined })
    expect(result.current).toBeUndefined()
  })
})

describe("useChangeSignal (AQU-2654)", () => {
  /** A consumer shaped like an editor row: a stable getter, read in a memo
   *  that lists the signal's version only while its surface is open. */
  function Reader({ getter, signal, open, onRender }: {
    getter: () => string
    signal: ChangeSignal
    open: boolean
    onRender: () => void
  }) {
    const version = useChangeSignalVersion(signal, open)
    // The version is a dependency precisely so a replaced getter is re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const value = useMemo(() => (open ? getter() : ""), [open, getter, version])
    onRender()
    return <span data-testid="value">{value}</span>
  }

  function Parent({ source, open, onRender }: { source: () => string; open: boolean; onRender: () => void }) {
    const getter = useStableCallback(source)
    const signal = useChangeSignal([source])
    // The memo stands in for React.memo on a list row: the child only renders
    // again when one of ITS inputs changes, and none of them does.
    return useMemo(
      () => <Reader getter={getter} signal={signal} open={open} onRender={onRender} />,
      [getter, signal, open, onRender],
    )
  }

  it("re-renders an open consumer when the getter is replaced, and re-reads it", () => {
    const onRender = vi.fn()
    const { getByTestId, rerender } = render(<Parent source={() => "one"} open onRender={onRender} />)
    expect(getByTestId("value").textContent).toBe("one")
    const rendersBefore = onRender.mock.calls.length

    rerender(<Parent source={() => "two"} open onRender={onRender} />)
    expect(getByTestId("value").textContent).toBe("two")
    expect(onRender.mock.calls.length).toBeGreaterThan(rendersBefore)
  })

  it("does not render a closed consumer when the getter is replaced", () => {
    const onRender = vi.fn()
    const { rerender } = render(<Parent source={() => "one"} open={false} onRender={onRender} />)
    const rendersBefore = onRender.mock.calls.length

    rerender(<Parent source={() => "two"} open={false} onRender={onRender} />)
    rerender(<Parent source={() => "three"} open={false} onRender={onRender} />)
    expect(onRender.mock.calls.length).toBe(rendersBefore)
  })

  it("does not bump when the watched values are unchanged", () => {
    const source = () => "same"
    const { result, rerender } = renderHook(() => useChangeSignal([source]))
    const before = result.current.getVersion()
    rerender()
    act(() => {})
    expect(result.current.getVersion()).toBe(before)
  })
})

describe("useStableValue (AQU-2654)", () => {
  it("keeps the previous map while a rebuilt one is equal, and takes a different one", () => {
    const a = new Map([["x", 2]])
    const { result, rerender } = renderHook(({ value }) => useStableValue(value, mapsEqual), { initialProps: { value: a } })
    expect(result.current).toBe(a)

    rerender({ value: new Map([["x", 2]]) })
    expect(result.current).toBe(a)

    const changed = new Map([["x", 3]])
    rerender({ value: changed })
    expect(result.current).toBe(changed)
  })

  it("mapsEqual compares keys and values, and treats undefined as its own value", () => {
    expect(mapsEqual(undefined, undefined)).toBe(true)
    expect(mapsEqual(new Map(), undefined)).toBe(false)
    expect(mapsEqual(new Map([["a", 1]]), new Map([["b", 1]]))).toBe(false)
    expect(mapsEqual(new Map([["a", 1]]), new Map([["a", 1], ["b", 1]]))).toBe(false)
    expect(mapsEqual(new Map([["a", { n: 1 }]]), new Map([["a", { n: 1 }]]), (x, y) => x.n === y.n)).toBe(true)
  })
})
