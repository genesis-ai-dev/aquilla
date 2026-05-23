import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AppRoutes } from "./App"

vi.mock("@/components/Dashboard", () => ({
  Dashboard: () => <div data-testid="dashboard" />,
}))

vi.mock("@/components/ProjectWorkspace", () => ({
  ProjectWorkspace: () => <div data-testid="workspace" />,
}))

vi.mock("@/components/DebugView", () => ({
  DebugView: () => <div data-testid="debug" />,
}))

vi.mock("@/components/RulesPage", () => ({
  RulesPage: () => <div data-testid="rules" />,
}))

vi.mock("@/components/LivingMemoryPage", () => ({
  LivingMemoryPage: () => <div data-testid="memory" />,
}))

vi.mock("@/components/CommentsPage", () => ({
  CommentsPage: () => <div data-testid="comments" />,
}))

vi.mock("@/components/SnapshotsPage", () => ({
  SnapshotsPage: () => <div data-testid="snapshots" />,
}))

vi.mock("@/components/AiModelConsentDialog", () => ({
  AiModelConsentDialog: () => null,
}))

vi.mock("@/components/AiModelDownloadChip", () => ({
  AiModelDownloadChip: () => null,
}))

vi.mock("@/components/AudioBulkProgressBanner", () => ({
  AudioBulkProgressBanner: () => null,
}))

vi.mock("@/components/PrivateModeBanner", () => ({
  PrivateModeBanner: () => null,
}))

vi.mock("@/components/DeployUpdateBanner", () => ({
  DeployUpdateBanner: () => null,
}))

vi.mock("@/context/SyncingContext", () => ({
  SyncingProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSyncing: () => ({ syncing: false }),
}))

vi.mock("@/hooks/useGlobalAudioShortcuts", () => ({
  useGlobalAudioShortcuts: vi.fn(),
}))

vi.mock("@/lib/audio/prefetch", () => ({
  hydratePrefetchStatus: vi.fn(),
}))

vi.mock("@/lib/storage/opfs-availability", () => ({
  probeOpfsAvailability: vi.fn(),
}))

function renderRoute(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

describe("AppRoutes", () => {
  it("opens workspace projects through the root-mounted dev route", () => {
    renderRoute("/project/project-123")

    expect(screen.getByTestId("workspace")).toBeInTheDocument()
  })

  it("opens workspace projects after the /w basename is stripped", () => {
    renderRoute("/project-123")

    expect(screen.getByTestId("workspace")).toBeInTheDocument()
  })

  it("opens nested workspace tools after the /w basename is stripped", () => {
    renderRoute("/project-123/rules")

    expect(screen.getByTestId("rules")).toBeInTheDocument()
  })
})
