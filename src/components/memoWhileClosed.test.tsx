import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { memoWhileClosed, mountOnFirstOpen } from "./memoWhileClosed"

function makeDialog(onRender: (title: string, open: boolean) => void) {
  return function Dialog({ open, title }: { open: boolean; title: string }) {
    const [clicks, setClicks] = useState(0)
    onRender(title, open)
    return (
      <div data-testid="dialog" data-open={open}>
        {title}
        <button type="button" onClick={() => setClicks((n) => n + 1)}>clicked {clicks}</button>
      </div>
    )
  }
}

describe("memoWhileClosed (AQU-2654)", () => {
  it("does not render while it stays closed, whatever else changes", () => {
    const onRender = vi.fn()
    const Dialog = memoWhileClosed(makeDialog(onRender))
    const { rerender } = render(<Dialog open={false} title="one" />)
    expect(onRender).toHaveBeenCalledTimes(1)

    rerender(<Dialog open={false} title="two" />)
    rerender(<Dialog open={false} title="three" />)
    expect(onRender).toHaveBeenCalledTimes(1)
  })

  it("opens with the props of that moment, renders while open, and renders the close", () => {
    const onRender = vi.fn()
    const Dialog = memoWhileClosed(makeDialog(onRender))
    const { rerender } = render(<Dialog open={false} title="one" />)
    rerender(<Dialog open={false} title="two" />)

    rerender(<Dialog open title="three" />)
    expect(onRender).toHaveBeenLastCalledWith("three", true)
    rerender(<Dialog open title="four" />)
    expect(onRender).toHaveBeenLastCalledWith("four", true)

    // The closing render is what lets the dialog play its exit animation.
    rerender(<Dialog open={false} title="five" />)
    expect(onRender).toHaveBeenLastCalledWith("five", false)
    const afterClose = onRender.mock.calls.length
    rerender(<Dialog open={false} title="six" />)
    expect(onRender).toHaveBeenCalledTimes(afterClose)
  })

  it("keeps the component mounted, so state survives a close and reopen", () => {
    const Dialog = memoWhileClosed(makeDialog(() => {}))
    const { rerender } = render(<Dialog open title="t" />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByRole("button").textContent).toBe("clicked 1")

    rerender(<Dialog open={false} title="t" />)
    rerender(<Dialog open={false} title="u" />)
    rerender(<Dialog open title="v" />)
    expect(screen.getByRole("button").textContent).toBe("clicked 1")
  })

  it("takes a custom notion of open for dialogs driven by another prop", () => {
    const onRender = vi.fn()
    function Split({ pieces }: { pieces: string[] | null; label: string }) {
      onRender()
      return <div>{pieces?.join(",")}</div>
    }
    const Wrapped = memoWhileClosed(Split, (props) => props.pieces !== null)
    const { rerender } = render(<Wrapped pieces={null} label="a" />)
    rerender(<Wrapped pieces={null} label="b" />)
    expect(onRender).toHaveBeenCalledTimes(1)
    rerender(<Wrapped pieces={["x"]} label="b" />)
    expect(onRender).toHaveBeenCalledTimes(2)
  })
})

describe("memoWhileClosed — a prop the dialog reads while closed (AQU-2654)", () => {
  it("renders the closed dialog when that prop changes, and for nothing else", () => {
    const onRender = vi.fn()
    function Drawer({ done }: { open: boolean; done: number; label: string }) {
      onRender(done)
      return null
    }
    const Wrapped = memoWhileClosed(Drawer, undefined, (previous, next) => previous.done === next.done)
    const { rerender } = render(<Wrapped open={false} done={1} label="a" />)
    rerender(<Wrapped open={false} done={1} label="b" />)
    expect(onRender).toHaveBeenCalledTimes(1)
    rerender(<Wrapped open={false} done={2} label="b" />)
    expect(onRender).toHaveBeenCalledTimes(2)
    expect(onRender).toHaveBeenLastCalledWith(2)
  })
})

describe("mountOnFirstOpen (AQU-2654)", () => {
  it("mounts nothing until the first open, then stays mounted and keeps its state", () => {
    const onRender = vi.fn()
    const Dialog = mountOnFirstOpen(makeDialog(onRender))
    const { rerender } = render(<Dialog open={false} title="one" />)
    rerender(<Dialog open={false} title="two" />)
    expect(onRender).not.toHaveBeenCalled()
    expect(screen.queryByTestId("dialog")).toBeNull()

    rerender(<Dialog open title="three" />)
    expect(onRender).toHaveBeenLastCalledWith("three", true)
    fireEvent.click(screen.getByRole("button"))

    // Closed again: still mounted (exit animation, remembered state) …
    rerender(<Dialog open={false} title="four" />)
    expect(screen.getByTestId("dialog").getAttribute("data-open")).toBe("false")
    // … and not rendered while it stays closed.
    const afterClose = onRender.mock.calls.length
    rerender(<Dialog open={false} title="five" />)
    expect(onRender).toHaveBeenCalledTimes(afterClose)

    rerender(<Dialog open title="six" />)
    expect(screen.getByRole("button").textContent).toBe("clicked 1")
  })
})

