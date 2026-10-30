// AQU-849 — the Verse Resources pane must fail inside itself: an inline reason,
// a Retry that re-runs the lookup, and a crash that does not escape the panel.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { VerseResourcesSidebar } from "./VerseResourcesSidebar"
import { loadEntityDetail, loadPassageEntities } from "@/lib/aquifer/passage-resources"

vi.mock("@/lib/aquifer/passage-resources", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/aquifer/passage-resources")
  >("@/lib/aquifer/passage-resources")
  return {
    ...actual,
    loadPassageEntities: vi.fn(),
    loadEntityDetail: vi.fn(),
    // The AQU-843 neighbour preload is covered in passage-resources.test.ts;
    // left real it would fetch the adjacent verses over the network.
    prefetchPassageEntities: vi.fn(),
  }
})

// The TaBiThA section (#950) fetches its own brief beside the Aquifer lookups
// this file exercises; TabithaBriefSection.test.tsx covers it. Left real it
// reaches production identity, which the AQU-1277 guard rejects.
vi.mock("@/lib/tabitha/verse-brief", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/tabitha/verse-brief")>()),
  loadVerseBrief: vi.fn(async () => ({
    available: false,
    lwcText: "",
    notes: [],
    translatorNotes: [],
    culturalBackground: [],
  })),
}))

const loadEntities = vi.mocked(loadPassageEntities)
const loadDetail = vi.mocked(loadEntityDetail)

function renderPane() {
  return render(
    <VerseResourcesSidebar
      projectId="p1"
      trackedRef="MAT 2:1"
      getJwt={() => "jwt"}
      open
      onToggle={() => {}}
    />,
  )
}

describe("VerseResourcesSidebar failure recovery (AQU-849)", () => {
  beforeEach(() => {
    localStorage.clear()
    loadEntities.mockReset()
    loadDetail.mockReset().mockResolvedValue({
      url: "https://example.test/herod",
      summary: "A client king.",
      coordinates: null,
      image: null,
    })
  })

  it("shows the reason inline and retries in place, without a reload", async () => {
    loadEntities
      .mockRejectedValueOnce(new Error("upstream 503"))
      .mockResolvedValueOnce([{ path: "/en/people/herod", title: "Herod", kind: "person" }])

    renderPane()

    const retry = await screen.findByRole("button", { name: "Retry" })
    expect(screen.getByText("Couldn't load resources: upstream 503")).toBeInTheDocument()

    fireEvent.click(retry)

    expect(await screen.findByText("Herod")).toBeInTheDocument()
    expect(
      screen.queryByText("Couldn't load resources: upstream 503"),
    ).not.toBeInTheDocument()
    expect(loadEntities).toHaveBeenCalledTimes(2)
  })

  it("keeps a render throw inside the pane and recovers on retry", async () => {
    loadEntities.mockImplementation(() => {
      throw new Error("boom")
    })

    renderPane()

    expect(
      await screen.findByText(
        "This panel stopped responding. Retry to reload it — your work is untouched.",
      ),
    ).toBeInTheDocument()

    loadEntities.mockReset().mockResolvedValue([])
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(screen.getByText("Verse Resources")).toBeInTheDocument())
  })
})

/** AQU-2260 (Sam, Oct 29): a control that carries its own words has no hover. */
async function expectNoHoverTip(el: Element) {
  await userEvent.setup().hover(el)
  await act(() => new Promise((r) => setTimeout(r, 30)))
  expect(screen.queryByRole("tooltip")).toBeNull()
}

describe("VerseResourcesSidebar — the closed edge tab", () => {
  it("carries its own word, so it has no hover", async () => {
    render(
      <TooltipProvider delay={0}>
        <VerseResourcesSidebar projectId="p1" trackedRef="MAT 2:1" getJwt={() => "jwt"} open={false} onToggle={() => {}} />
      </TooltipProvider>,
    )
    await expectNoHoverTip(screen.getByRole("button", { name: "Show verse resources" }))
  })
})
