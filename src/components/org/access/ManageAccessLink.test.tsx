/**
 * AQU-2324: the "Manage access" door from older rosters into People & access.
 * Why these matter: the door must land on the same place or filter the reader
 * came from (the access page's own parsers decide what is selected), it must
 * be an ordinary push so Back returns to the old surface, and it must not be
 * offered to a guest, whom OrgRouteGate sends away from `/orgs/:id/access`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"

import { parseAccessLens, parsePeopleFilter } from "@/lib/access/people-lens"
import { parsePlaceParam } from "@/lib/access/place-lens"
import { orgAccessPath } from "@/lib/navigation/org-paths"

import { ManageAccessLink } from "./ManageAccessLink"

const orgContext = vi.hoisted(() => ({ value: null as null | { orgs: { id: number }[] } }))
vi.mock("@/context/OrgContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/context/OrgContext")>()),
  useActiveOrgOptional: () => orgContext.value,
}))

/** Stands in for OrgAccessPage: reads the params the way it and PlacesLens do. */
function AccessPageProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const place = parsePlaceParam(params.get("place"))
  return (
    <div>
      <p data-testid="probe-lens">{parseAccessLens(params.get("lens"))}</p>
      <p data-testid="probe-filter">{parsePeopleFilter(params.get("people"))}</p>
      <p data-testid="probe-place">{place ? `${place.type}/${place.id}` : "none"}</p>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </div>
  )
}

function renderDoor(open: Parameters<typeof orgAccessPath>[1], orgId: number | null = 7) {
  return render(
    <MemoryRouter initialEntries={["/old-surface"]}>
      <Routes>
        <Route path="/old-surface" element={<div><p>old surface</p><ManageAccessLink orgId={orgId} open={open} /></div>} />
        <Route path="/orgs/:orgId/access" element={<AccessPageProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  orgContext.value = { orgs: [{ id: 7 }] }
})

describe("ManageAccessLink", () => {
  it("opens the Places lens on the place it was given, and Back returns to the old surface", () => {
    renderDoor({ place: { type: "lane", id: "lane/1 fr" } })

    fireEvent.click(screen.getByRole("link", { name: "Manage access" }))

    expect(screen.getByTestId("probe-lens")).toHaveTextContent("places")
    expect(screen.getByTestId("probe-place")).toHaveTextContent("lane/lane/1 fr")
    fireEvent.click(screen.getByRole("button", { name: "back" }))
    expect(screen.getByText("old surface")).toBeInTheDocument()
  })

  it.each([
    [{ people: "guests" } as const, "guests"],
    [{ people: "everyone" } as const, "everyone"],
  ])("opens the People lens on the filter it was given (%o)", (open, filter) => {
    renderDoor(open)

    fireEvent.click(screen.getByRole("link", { name: "Manage access" }))

    expect(screen.getByTestId("probe-lens")).toHaveTextContent("people")
    expect(screen.getByTestId("probe-filter")).toHaveTextContent(filter)
  })

  it("is not offered to someone who is not a member of that organization, or with no org context", () => {
    orgContext.value = { orgs: [{ id: 8 }] }
    const { unmount } = renderDoor({ place: { type: "project", id: "p1" } })
    expect(screen.queryByRole("link", { name: "Manage access" })).not.toBeInTheDocument()
    unmount()

    orgContext.value = null
    renderDoor({ place: { type: "project", id: "p1" } })
    expect(screen.queryByRole("link", { name: "Manage access" })).not.toBeInTheDocument()
  })
})
