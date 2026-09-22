import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import { StatusBar as StatusBarView } from "./StatusBar"
import { useHealth } from "@/hooks/useHealth"
import { useCallback, type ComponentProps } from "react"

function StatusBar({ cells, healthMap, ...props }: {
  cells: readonly CellSummary[]; healthMap: Map<string, number>
} & Omit<ComponentProps<typeof StatusBarView>, "progress" | "getHealthByCell">) {
  // Use the same live counter source as the workspace, including when health
  // scoring is off. The footer must not regress to server snapshot counters.
  const { fileProgress } = useHealth(new Map([["active", cells]]), [], { enabled: false })
  const getHealthByCell = useCallback(() => cells.map(cell => ({
    cellId: cell.id, label: cell.cellLabel || cell.id, health: healthMap.get(cell.id) ?? 0,
  })), [cells, healthMap])
  return <StatusBarView progress={fileProgress.get("active")!} getHealthByCell={getHealthByCell} {...props} />
}

const cells = [
  { id: "a", cellLabel: "Genesis 1:1", status: "empty" },
  { id: "b", cellLabel: "Genesis 1:2", status: "validated" },
] as CellSummary[]

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-slot="popover-trigger"]')!
}

describe("StatusBar health breakdown", () => {
  it("does no per-cell health reads while closed, then shows current data and jump actions", async () => {
    const healthMap = new Map([["a", 10], ["b", 100]])
    const get = vi.spyOn(healthMap, "get")
    const onJumpToCell = vi.fn()
    const { container, rerender } = render(<StatusBar cells={cells} healthMap={healthMap} projectHealth={55} onJumpToCell={onJumpToCell} />)
    expect(get).not.toHaveBeenCalled()
    fireEvent.click(trigger(container))
    const first = await screen.findByRole("button", { name: /Genesis 1:1.*10%/ })
    fireEvent.click(first)
    expect(onJumpToCell).toHaveBeenCalledWith("a")

    // Live score changes while open must update both the score and ranking.
    const updated = new Map([["a", 100], ["b", 15]])
    rerender(<StatusBar cells={cells} healthMap={updated} projectHealth={58} onJumpToCell={onJumpToCell} />)
    expect(await screen.findByRole("button", { name: /Genesis 1:2.*15%/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Genesis 1:1/ })).toBeNull()
    fireEvent.click(trigger(container))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Genesis 1:2/ })).toBeNull())

    const next = new Map([["c", 5]])
    const nextGet = vi.spyOn(next, "get")
    const nextCells = [{ id: "c", cellLabel: "New lane", status: "unvalidated" }] as CellSummary[]
    rerender(<StatusBar cells={nextCells} healthMap={next} projectHealth={5} />)
    expect(nextGet).not.toHaveBeenCalled()
    fireEvent.click(trigger(container))
    expect(await screen.findByRole("button", { name: /New lane.*5%/ })).toBeDisabled()
  })

  it("opens from hover and handles an empty scope", async () => {
    const { container } = render(<StatusBar cells={[]} healthMap={new Map()} projectHealth={100} />)
    fireEvent.pointerEnter(trigger(container), { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger(container))
    fireEvent.mouseMove(trigger(container))
    expect(await screen.findByText("project health")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Genesis/ })).toBeNull()
  })

  it("does not build breakdown data for a closed large file", () => {
    const healthMap = new Map<string, number>()
    const get = vi.spyOn(healthMap, "get")
    const many = Array.from({ length: 31_215 }, (_, i) => ({ ...cells[0], id: String(i) }))
    const { rerender } = render(<StatusBar cells={many} healthMap={healthMap} projectHealth={0} />)
    rerender(<StatusBar cells={[...many]} healthMap={healthMap} projectHealth={1} />)
    expect(get).not.toHaveBeenCalled()
  })
})

it("updates footer counts across empty, drafted, validated and removed cells", () => {
  const healthMap = new Map<string, number>()
  const { container, rerender } = render(<StatusBar cells={cells} healthMap={healthMap} projectHealth={0} />)
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("2 cells")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("1 translated")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("1 validated")
  const drafted = [{ ...cells[0], status: "unvalidated" as const }, cells[1]]
  rerender(<StatusBar cells={drafted} healthMap={healthMap} projectHealth={0} />)
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("2 translated")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("1 unvalidated")
  rerender(<StatusBar cells={[]} healthMap={healthMap} projectHealth={0} />)
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("0 cells")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("0 translated")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).not.toContain("unvalidated")
})
