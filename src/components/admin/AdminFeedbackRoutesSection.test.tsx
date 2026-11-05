/**
 * AdminFeedbackRoutesSection: the project picker must make 26 projects quick
 * to choose, and a save must send exactly the picked ids and parsed addresses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { AdminFeedbackRoutesSection, parseEmailList } from "./AdminFeedbackRoutesSection"

vi.mock("@/lib/frontier/admin", () => ({
  getAdminFeedbackRoutes: vi.fn(),
  getAdminOrgs: vi.fn(),
  getAdminProjects: vi.fn(),
  createAdminFeedbackRoute: vi.fn(),
  updateAdminFeedbackRoute: vi.fn(),
  deleteAdminFeedbackRoute: vi.fn(),
}))
import * as api from "@/lib/frontier/admin"

const project = (id: string, name: string) =>
  ({ id, name, orgId: 5, orgName: "Org Five" }) as unknown as Awaited<ReturnType<typeof api.getAdminProjects>>[number]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getAdminFeedbackRoutes).mockResolvedValue([
    {
      id: 1,
      orgId: 5,
      orgName: "Org Five",
      projectIds: ["a"],
      projects: [{ id: "a", name: "Alpha" }],
      emails: ["x@example.com"],
      label: null,
      enabled: true,
      createdAt: null,
    },
  ])
  vi.mocked(api.getAdminOrgs).mockResolvedValue([{ id: 5, name: "Org Five" }] as never)
  vi.mocked(api.getAdminProjects).mockResolvedValue([
    project("a", "Alpha"),
    project("b", "Beta"),
    project("c", "Bravo"),
  ])
  vi.mocked(api.updateAdminFeedbackRoute).mockResolvedValue({} as never)
})

describe("parseEmailList", () => {
  it("splits on lines and commas, lowercases and dedupes", () => {
    expect(parseEmailList("A@example.com, b@example.com\nA@example.com;;")).toEqual([
      "a@example.com",
      "b@example.com",
    ])
  })
})

describe("AdminFeedbackRoutesSection", () => {
  it("lists a route and saves an edit with the filtered select-all", async () => {
    render(<AdminFeedbackRoutesSection jwt="t" />)
    expect(await screen.findByText("1 project")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))

    fireEvent.change(screen.getByLabelText("Filter projects"), { target: { value: "br" } })
    fireEvent.click(screen.getByRole("button", { name: "Select all shown" }))
    expect(screen.getByText("2 selected")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Save route" }))
    await waitFor(() => expect(api.updateAdminFeedbackRoute).toHaveBeenCalled())
    expect(vi.mocked(api.updateAdminFeedbackRoute).mock.calls[0][1]).toBe(1)
    expect(vi.mocked(api.updateAdminFeedbackRoute).mock.calls[0][2]).toMatchObject({
      projectIds: expect.arrayContaining(["a", "c"]),
      emails: ["x@example.com"],
    })
  })
})
