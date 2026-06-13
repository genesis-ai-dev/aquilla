// Tests for UsageRollup: per-member usage on the org Overview (manager view).
//
// WHY these tests matter: UsageRollup is a MANAGER-ONLY surface. The 403
// swallow is a trust boundary — non-managers must never see other members'
// usage. The zero-hiding prevents noise for orgs that haven't used TTS/AI yet.
// These tests lock those two invariants so regressions are caught at CI.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { UsageRollup } from "./UsageRollup"
import type { OrgUsage } from "@/lib/sync/usage"

vi.mock("@/lib/sync/usage", () => ({ getOrgUsage: vi.fn() }))
import { getOrgUsage } from "@/lib/sync/usage"
const mockGetOrgUsage = vi.mocked(getOrgUsage)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const MEMBERS_WITH_USAGE: OrgUsage = {
  orgTotal: { audioSeconds: 245, ttsRequests: 4, llmRequests: 8 },
  members: [
    { userId: 2, username: "wendi", audioSeconds: 180, ttsRequests: 3, llmRequests: 5 },
    { userId: 3, username: "randall", audioSeconds: 65, ttsRequests: 1, llmRequests: 3 },
  ],
}

describe("UsageRollup", () => {
  it("renders per-member audio time and request counts for a manager", async () => {
    // WHY: the org Overview is the manager's oversight surface. If member usage
    // does not display correctly, Wendi/Randall/Anna cannot see team activity.
    mockGetOrgUsage.mockResolvedValue(MEMBERS_WITH_USAGE)
    render(<UsageRollup jwt="mgr-jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("Team usage")).toBeInTheDocument())

    expect(screen.getByText("wendi")).toBeInTheDocument()
    // 180 s = 3 min 0 s
    expect(screen.getByText("3 min audio")).toBeInTheDocument()
    // 3 + 5 = 8 AI requests
    expect(screen.getByText("8 AI requests")).toBeInTheDocument()

    expect(screen.getByText("randall")).toBeInTheDocument()
    // 65 s = 1 min 5 s
    expect(screen.getByText("1 min 5 s audio")).toBeInTheDocument()
    // 1 + 3 = 4 AI requests
    expect(screen.getByText("4 AI requests")).toBeInTheDocument()

    expect(mockGetOrgUsage).toHaveBeenCalledWith("mgr-jwt", 1)
  })

  it("renders nothing when the caller is not a manager (getOrgUsage returns null for 403)", async () => {
    // WHY: this is the TRUST BOUNDARY. A non-manager calling the endpoint gets
    // a 403 → getOrgUsage returns null → the section must be invisible.
    // If this test fails it means team usage data leaks to non-managers.
    mockGetOrgUsage.mockResolvedValue(null) // null = 403 (maintainer gate)
    const { container } = render(<UsageRollup jwt="member-jwt" orgId={1} />)
    await waitFor(() => expect(mockGetOrgUsage).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("Team usage")).not.toBeInTheDocument()
  })

  it("renders nothing when all members have zero usage (no noise for unused orgs)", async () => {
    // WHY: an org that hasn't used TTS/AI yet should not see an empty table.
    // Noise-free display keeps the Overview dashboard clean.
    const zeroUsage: OrgUsage = {
      orgTotal: { audioSeconds: 0, ttsRequests: 0, llmRequests: 0 },
      members: [
        { userId: 2, username: "wendi", audioSeconds: 0, ttsRequests: 0, llmRequests: 0 },
      ],
    }
    mockGetOrgUsage.mockResolvedValue(zeroUsage)
    const { container } = render(<UsageRollup jwt="mgr-jwt" orgId={1} />)
    await waitFor(() => expect(mockGetOrgUsage).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("hides on transient fetch errors (e.g. network failure)", async () => {
    // WHY: the usage section is additive — a transient failure should not break
    // the org Overview page. It must silently disappear rather than crashing.
    mockGetOrgUsage.mockRejectedValue(new Error("network error"))
    const { container } = render(<UsageRollup jwt="mgr-jwt" orgId={1} />)
    await waitFor(() => expect(mockGetOrgUsage).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
