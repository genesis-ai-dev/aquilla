import { describe, expect, it } from "vitest"
import { render, renderHook, screen, waitFor } from "@testing-library/react"
import { useProgressiveCount } from "./useProgressiveCount"

function counts(total: number, initial?: number) {
  const seen: number[] = []
  const hook = renderHook(
    ({ n }) => {
      const count = useProgressiveCount(n, initial)
      seen.push(count)
      return count
    },
    { initialProps: { n: total } },
  )
  return { seen, hook }
}

describe("useProgressiveCount", () => {
  it("draws a short list whole, in one render", () => {
    const { seen } = counts(40)
    expect(seen).toEqual([40])
  })

  it("draws the first screen of a long list, then all of it", async () => {
    const { seen, hook } = counts(664)
    expect(seen[0]).toBe(80)
    await waitFor(() => expect(hook.result.current).toBe(664))
    // Never anything between: the remainder lands as one commit.
    expect(new Set(seen)).toEqual(new Set([80, 664]))
  })

  it("stages a list that only becomes long after its data arrives", async () => {
    const { seen, hook } = counts(0, 10)
    hook.rerender({ n: 500 })
    expect(seen).toContain(10)
    await waitFor(() => expect(hook.result.current).toBe(500))
  })

  it("once shown in full, later growth is drawn at once", async () => {
    const { seen, hook } = counts(200, 50)
    await waitFor(() => expect(hook.result.current).toBe(200))
    seen.length = 0
    hook.rerender({ n: 201 })
    expect(seen).toEqual([201])
  })

  it("every row ends up in the document, so find-in-page reaches all of them", async () => {
    function List({ items }: { items: string[] }) {
      const count = useProgressiveCount(items.length, 5)
      return (
        <ul>
          {items.slice(0, count).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )
    }
    render(<List items={Array.from({ length: 60 }, (_, i) => `term ${i}`)} />)
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(60))
    expect(screen.getByText("term 59")).toBeInTheDocument()
  })
})
