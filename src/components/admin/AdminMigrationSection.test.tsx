import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { AdminMigrationSection } from "./AdminMigrationSection"
import { getAdminMigrationStatus, type MigrationStatus } from "@/lib/frontier/admin"

vi.mock("@/lib/frontier/admin", () => ({ getAdminMigrationStatus: vi.fn() }))

const mockGet = vi.mocked(getAdminMigrationStatus)
const STATUS: MigrationStatus = {
  schemaVersion: 1,
  runner: "daemon@hetzner",
  heartbeatAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dryRun: false,
  queue: {
    projects: [{ status: "ok", count: 1 }],
    jobs: [
      { kind: "content", stage: "done", count: 1 },
      { kind: "audio", stage: "detected", count: 1 },
    ],
    recentJobs: [{
      id: 8,
      project_id: 47,
      project_name: "Sample",
      namespace: "org/team",
      kind: "audio",
      sha: "abc123",
      stage: "detected",
      attempts: 1,
      next_run_at: 0,
      updated_at: Date.now(),
      error: "temporary R2 error",
    }],
  },
  active: [],
  lastInboxPollAt: null,
  lastInboxEnqueued: 0,
  lastReconcileAt: null,
  lastReconcileEnqueued: 0,
  reconcileHighWaterMark: null,
}

afterEach(() => vi.clearAllMocks())

describe("AdminMigrationSection", () => {
  it("shows content and audio queue counts and recent retry errors", async () => {
    mockGet.mockResolvedValue(STATUS)
    const { unmount } = render(<AdminMigrationSection jwt="jwt" />)
    await waitFor(() => expect(screen.getByText("daemon@hetzner · live · daemon is running")).toBeInTheDocument())
    expect(mockGet).toHaveBeenCalledWith("jwt")
    expect(screen.getByText("Content queued").parentElement?.parentElement).toHaveTextContent("0")
    expect(screen.getByText("Audio queued").parentElement?.parentElement).toHaveTextContent("1")
    expect(screen.getByText("org/team/Sample · audio")).toBeInTheDocument()
    expect(screen.getByText("temporary R2 error")).toBeInTheDocument()
    unmount()
  })
})
