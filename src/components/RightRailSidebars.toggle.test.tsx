/**
 * AQU-1316 — the right rail's two scripture sidebars toggle, and say so.
 *
 * The report was that the X in the panel header did nothing and that clicking
 * an edge tab piled up duplicate Parallel Bibles panels. The layout rule that
 * makes duplicates unrepresentable is pinned in
 * `src/lib/editor/right-rail-panels.test.ts`; what is pinned here is the other
 * half of the contract, at the component boundary: each sidebar renders exactly
 * one surface for a given `open`, and BOTH of its surfaces report a close/open
 * intent through the one `onToggle` the workspace persists from. A close button
 * that silently dropped the click (the reported symptom) or an edge tab wired
 * to something other than `onToggle` would leave the persisted flag and the
 * visible UI disagreeing — AC4 — with no reload-free way back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import {
  ParallelBiblesSidebar,
  readParallelBiblesOpen,
  writeParallelBiblesOpen,
} from "./ParallelBiblesSidebar"
import {
  VerseResourcesSidebar,
  readVerseResourcesOpen,
  writeVerseResourcesOpen,
} from "./VerseResourcesSidebar"

vi.mock("@/lib/parsers/helloao", () => ({
  fetchHelloaoTranslations: vi.fn().mockResolvedValue([]),
  fetchHelloaoChapter: vi.fn().mockResolvedValue({ chapter: { content: [] } }),
  flattenHelloaoContent: vi.fn(),
}))

vi.mock("@/lib/aquifer/passage-resources", () => ({
  buildMapMosaic: vi.fn(() => null),
  formatCoordinates: vi.fn(() => ""),
  loadEntityDetail: vi.fn().mockResolvedValue(null),
  loadPassageEntities: vi.fn().mockResolvedValue([]),
  MAX_DETAIL_LOOKUPS: 5,
  osmPermalink: vi.fn(() => "https://example.invalid"),
  OSM_TILE_SIZE: 256,
  passagePathFromRef: vi.fn((ref: string | null) => ref),
}))

const PROJECT_ID = "project-1316"

function renderBibles(open: boolean, onToggle: () => void) {
  return render(
    <ParallelBiblesSidebar trackedRef="GEN 1:1" open={open} onToggle={onToggle} />,
  )
}

function renderResources(open: boolean, onToggle: () => void) {
  return render(
    <VerseResourcesSidebar
      projectId={PROJECT_ID}
      trackedRef="GEN 1:1"
      getJwt={() => null}
      open={open}
      onToggle={onToggle}
    />,
  )
}

describe.each([
  {
    name: "Parallel Bibles",
    renderSidebar: renderBibles,
    hideLabel: "Hide parallel bibles",
    showLabel: "Show parallel bibles",
  },
  {
    name: "Verse Resources",
    renderSidebar: renderResources,
    hideLabel: "Hide verse resources",
    showLabel: "Show verse resources",
  },
])("$name sidebar toggling (AQU-1316)", ({ renderSidebar, hideLabel, showLabel }) => {
  beforeEach(() => localStorage.clear())

  // AC1: the X in the panel header is the close control, and it reports the
  // close to the workspace rather than swallowing it.
  it("calls onToggle when the panel's close button is clicked", () => {
    const onToggle = vi.fn()
    renderSidebar(true, onToggle)

    fireEvent.click(screen.getByRole("button", { name: hideLabel }))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  // AC2: the collapsed edge tab is the reopen control, through the same channel.
  it("calls onToggle when the collapsed edge tab is clicked", () => {
    const onToggle = vi.fn()
    renderSidebar(false, onToggle)

    fireEvent.click(screen.getByRole("button", { name: showLabel }))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  // AC3, at the component boundary: one `open` value, one surface. The panel and
  // its own edge tab are never both in the tree.
  it("renders the panel or the edge tab, never both", () => {
    const { unmount } = renderSidebar(true, vi.fn())
    expect(screen.getByRole("button", { name: hideLabel })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: showLabel })).not.toBeInTheDocument()
    unmount()

    renderSidebar(false, vi.fn())
    expect(screen.getByRole("button", { name: showLabel })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: hideLabel })).not.toBeInTheDocument()
  })

  // The X is a real control, not decoration behind an overlay: a rerender with
  // the closed state (what the workspace does on toggle) takes the panel away.
  it("closes the panel when the parent flips open after the close click", () => {
    let open = true
    const onToggle = vi.fn(() => {
      open = false
    })
    const { unmount } = renderSidebar(true, onToggle)
    fireEvent.click(screen.getByRole("button", { name: hideLabel }))
    expect(open).toBe(false)
    unmount()

    renderSidebar(open, onToggle)
    expect(screen.queryByRole("button", { name: hideLabel })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: showLabel })).toBeInTheDocument()
  })
})

// AC4 / regression guard: the persisted flag is per project and round-trips, so
// the state the workspace seeds from on the next load is the state it wrote.
describe.each([
  {
    name: "aquilla:parallel-bibles:<projectId>:open",
    read: readParallelBiblesOpen,
    write: writeParallelBiblesOpen,
    key: `aquilla:parallel-bibles:${PROJECT_ID}:open`,
  },
  {
    name: "aquilla:verse-resources:<projectId>:open",
    read: readVerseResourcesOpen,
    write: writeVerseResourcesOpen,
    key: `aquilla:verse-resources:${PROJECT_ID}:open`,
  },
])("$name persistence (AQU-1316)", ({ read, write, key }) => {
  beforeEach(() => localStorage.clear())

  it("defaults to closed when nothing is stored", () => {
    expect(read(PROJECT_ID)).toBe(false)
  })

  it("round-trips both states under the documented key", () => {
    write(PROJECT_ID, true)
    expect(localStorage.getItem(key)).toBe("true")
    expect(read(PROJECT_ID)).toBe(true)

    write(PROJECT_ID, false)
    expect(localStorage.getItem(key)).toBe("false")
    expect(read(PROJECT_ID)).toBe(false)
  })

  it("keeps each project's flag separate", () => {
    write(PROJECT_ID, true)
    expect(read("another-project")).toBe(false)
  })
})
