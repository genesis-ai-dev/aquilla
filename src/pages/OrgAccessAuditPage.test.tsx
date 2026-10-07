import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { OrgAccessAuditPage } from "./OrgAccessAuditPage"
import type { AccessAuditReport, AccessAuditResult } from "@/components/org/access/access-audit-data"

vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))

let jwt: string | null = "jwt"
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: jwt ? { jwt } : null, loading: false }),
}))
const useActiveOrg = vi.fn()
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => useActiveOrg() }))

const pending = new Map<number, (result: AccessAuditResult) => void>()
vi.mock("@/components/org/access/access-audit-data", async () => {
  const actual = await vi.importActual<typeof import("@/components/org/access/access-audit-data")>(
    "@/components/org/access/access-audit-data",
  )
  return {
    ...actual,
    fetchAccessAudit: (_jwt: string, orgId: number) =>
      new Promise<AccessAuditResult>((resolve) => pending.set(orgId, resolve)),
  }
})

const downloadBlob = vi.fn()
vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}))

function report(orgName: string): AccessAuditReport {
  return {
    orgId: 1,
    orgName,
    generatedAt: "2026-10-07T03:00:00.000Z",
    people: [
      {
        userId: "2",
        username: "anna",
        displayName: "Anna",
        orgRole: 100,
        teams: [{ teamId: "5", name: "Translators", roleLevel: 500 }],
        projects: [
          {
            projectId: "pa",
            projectName: "John",
            role: { level: 400, name: "contributor", source: "group" },
            lanes: [{ laneId: "lane-fr", name: "French", roleLevel: 300 }],
          },
        ],
      },
    ],
  }
}

const setOrg = (id: number | null) =>
  useActiveOrg.mockReturnValue({
    activeOrg: id == null ? null : { id, name: `Org ${id}` },
    activeOrgId: id,
  })

const print = vi.fn()

describe("OrgAccessAuditPage", () => {
  beforeEach(() => {
    pending.clear()
    jwt = "jwt"
    downloadBlob.mockReset()
    print.mockReset()
    window.print = print
  })

  it("renders the tree and prints or exports only the loaded org", async () => {
    setOrg(1)
    const { rerender } = render(
      <MemoryRouter>
        <OrgAccessAuditPage />
      </MemoryRouter>,
    )
    await act(async () => pending.get(1)?.({ ok: true, report: report("Alpha") }))
    expect(screen.getByTestId("access-audit-person-2")).toHaveTextContent("Anna")
    expect(screen.getByTestId("access-audit-person-2")).toHaveTextContent("Viewer")
    expect(screen.getByTestId("access-audit-person-2")).toHaveTextContent("Translators (Project lead)")
    expect(screen.getByTestId("access-audit-project-2-pa")).toHaveTextContent("John")
    expect(screen.getByTestId("access-audit-project-2-pa")).toHaveTextContent("Contributor (Team)")
    expect(screen.getByTestId("access-audit-project-2-pa")).toHaveTextContent("French (Reviewer)")

    screen.getByRole("button", { name: "Print" }).click()
    expect(window.print).toHaveBeenCalledOnce()

    screen.getByRole("button", { name: "Export CSV" }).click()
    expect(downloadBlob).toHaveBeenCalledOnce()
    const csv = (downloadBlob.mock.calls[0]![0] as Blob)
    expect(await csv.text()).toContain("French,Reviewer")
    expect(downloadBlob.mock.calls[0]![1]).toBe("Alpha-access-audit.csv")

    setOrg(2)
    rerender(
      <MemoryRouter>
        <OrgAccessAuditPage />
      </MemoryRouter>,
    )
    expect(screen.queryByText("Anna")).toBeNull()
    expect(screen.getByRole("button", { name: "Print" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled()
  })

  it("tells a below-maintainer caller the report is for owners and maintainers", async () => {
    setOrg(1)
    render(
      <MemoryRouter>
        <OrgAccessAuditPage />
      </MemoryRouter>,
    )
    await act(async () => pending.get(1)?.({ ok: false, reason: "forbidden" }))
    expect(screen.getByRole("alert")).toHaveTextContent(/owners and maintainers/i)
  })
})
