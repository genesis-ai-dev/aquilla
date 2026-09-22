import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import { StatusBar as StatusBarView } from "./StatusBar"
import { useHealth } from "@/hooks/useHealth"
import { applyStructuralPolicy } from "@/lib/cells/structural"
import { useCallback, type ComponentProps } from "react"

function StatusBar({ cells, healthMap, countStructural = true, ...props }: {
  cells: readonly CellSummary[]; healthMap: Map<string, number>; countStructural?: boolean
} & Omit<ComponentProps<typeof StatusBarView>, "progress" | "getHealthByCell">) {
  // Use the same live counter source as the workspace, including when health
  // scoring is off. The footer must not regress to server snapshot counters.
  // AQU-1083: and the same policy step the workspace applies on top of it.
  const { fileProgress } = useHealth(new Map([["active", cells]]), [], { enabled: false })
  const progress = applyStructuralPolicy(fileProgress.get("active")!, cells, countStructural)
  const getHealthByCell = useCallback(() => cells.map(cell => ({
    cellId: cell.id, label: cell.cellLabel || cell.id, health: healthMap.get(cell.id) ?? 0,
  })), [cells, healthMap])
  return <StatusBarView progress={progress} getHealthByCell={getHealthByCell} {...props} />
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

// AQU-1083. The editor footer is the ONE progress surface whose number is
// counted on the client (useHealth over the open file's cells) rather than
// read from the server, so it is the one place the policy can silently
// disagree with the rest of the app for the same file.
describe("StatusBar and the structural-cell policy", () => {
  const cell = (id: string, type: string, status: CellSummary["status"]): CellSummary =>
    ({ id, cellLabel: id, type, status } as CellSummary)

  /** Two verses (one translated) and two headings (both translated). */
  const CELLS: CellSummary[] = [
    cell("v1", "verse", "unvalidated"),
    cell("v2", "verse", "empty"),
    cell("h1", "heading", "validated"),
    cell("h2", "paratext", "unvalidated"),
  ]

  /** Bidi isolates wrap every formatted number (an Arabic reordering fix), so
   *  strip them before matching or every assertion here is unreadable. */
  const plain = (el: HTMLElement) => (el.textContent ?? "").replace(/[\u2066-\u2069]/g, "")

  it("counts headings by default", () => {
    // Absent policy must behave exactly as the footer did before the setting
    // existed: four cells, three of them with content.
    const { container } = render(<StatusBar cells={CELLS} healthMap={new Map()} projectHealth={100} />)
    expect(plain(container)).toContain("4 cells")
    expect(plain(container)).toContain("3")
  })

  it("drops headings from both halves of the ratio when excluded", () => {
    // Not just the denominator: a translated chapter title must leave the
    // numerator too, or the percentage climbs for work nobody did. Two verses
    // remain, one of them translated — 50%, not 75%.
    const { container } = render(
      <StatusBar cells={CELLS} healthMap={new Map()} projectHealth={100} countStructural={false} />,
    )
    expect(plain(container)).toContain("2 cells")
    expect(plain(container)).toContain("50")
    expect(plain(container)).not.toContain("4 cells")
  })
})
