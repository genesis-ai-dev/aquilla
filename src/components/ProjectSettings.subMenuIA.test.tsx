// AQU-501 — Project settings sub-menu IA.
//
// Why these tests exist: Project Settings used to render every section on one
// long scrolling page with a scroll-spy TOC. That made a single setting hard
// to find and gave no sense of where you were. This converts it to the same
// index -> detail pane pattern org Settings uses (src/pages/Settings.tsx):
// picking a sub-section from a NavList shows only that pane, navigated via an
// internal `?section=` search param (no new route — App.tsx untouched).
//
// These tests encode the acceptance criteria directly:
//   1. Landing on /settings with no `section` param shows an index of labeled
//      sub-menus, not the full set of controls.
//   2. Picking a sub-menu link navigates to `?section=<id>` and renders ONLY
//      that group's controls — a setting from a different group must not be
//      in the document at the same time (the "no more one long scroll" bar).
//   3. A `?section=` deep link renders directly into that pane (so the pane is
//      link-able, not just reachable by clicking through).
//   4. No section was dropped: every previously-available control is still
//      reachable through some sub-menu (spot-checks one control per group).
//   5. The Settings breadcrumb returns to the index.
//   6. Living Memory extraction: the `memory`, `rules`, and `system-prompt`
//      sections are gone from settings, and their legacy URLs redirect
//      (page AND route-modal) to the standalone /project/:id/memory surface —
//      memory → /memory, rules → /memory/quality, system-prompt →
//      /memory/instructions — preserving the query string.
//   7. The AI pane keeps a cross-link NavRow to Living Memory (instructions)
//      with the old Custom/Default system-prompt hint semantics.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { MemoryRouter, Route, Routes, Link, useLocation } from "react-router-dom"
import { ProjectSettings, ProjectSettingsDialog } from "./ProjectSettings"


vi.mock("@/components/org/OrgSidebar", () => ({
  OrgSidebar: () => <div data-testid="org-sidebar">sidebar</div>,
}))
vi.mock("@/components/org/OrgBreadcrumb", () => ({
  OrgBreadcrumb: ({ section, trail }: { section: string; trail?: { label: string; to?: string }[] }) => (
    <div data-testid="org-breadcrumb">
      {section}
      {(trail ?? []).map((t: { label: string; to?: string }) =>
        t.to ? (
          <Link key={t.label} to={t.to}>
            {t.label}
          </Link>
        ) : (
          <span key={t.label}>{` › ${t.label}`}</span>
        ),
      )}
    </div>
  ),
}))

import type { ProjectRecord } from "@/lib/parsers/types"

const PROJECT_ID = "proj-submenu-ia"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: "Sub-menu IA Test Project",
    files: [{ id: "f1", name: "GEN.usfm", type: "usfm", createdAt: "", cellCount: 1 }],
    sourceLanguage: "English",
    targetLanguage: "French",
    syncRole: { level: 700, source: "creator" },
    // Give every group something to render: git-sync origin, no source link
    // (kept simple — source-link/upstream tested for visibility separately
    // isn't needed here since "General" and "AI" alone already prove the
    // per-pane isolation contract).
    origin: { kind: "git", cloneUrl: "https://example.test/repo.git", branch: "main" },
    ...overrides,
  } as unknown as ProjectRecord
}

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: makeProject(),
    loading: false,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    canEdit: true,
    reasonCannotEdit: null,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    version: 1,
    updatedAt: null,
    updatedBy: null,
    conflict: false,
    dismissConflict: vi.fn(),
    settings: {},
    hasFetched: true,
    isOnline: true,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/hooks/useOrg", () => ({
  useOrg: () => ({ org: null }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: null, sessions: [], loading: false, add: vi.fn(), activate: vi.fn(), remove: vi.fn() }),
}))

vi.mock("@/hooks/useCompletionSettings", () => ({
  buildCompletionSettings: vi.fn((existing: unknown, updates: unknown) => ({ ...Object(existing), ...Object(updates) })),
  DEFAULT_SYSTEM_PROMPT: "Translate accurately.",
}))

vi.mock("@/lib/completion/completion-service", async (importOriginal) => {
  // Partial mock: ProjectSettings and other modules in its render tree read
  // real constants from this module at module-eval time (FRONTIER_CHAT_URL via
  // lib/ab/feedback.ts, DEFAULT_COMPLETION_MAX_TOKENS for initial state) —
  // keep every real export and stub only the network-touching functions.
  const actual = await importOriginal<typeof import("@/lib/completion/completion-service")>()
  return {
    ...actual,
    fetchModels: vi.fn().mockResolvedValue([]),
    resolveProvider: vi.fn(() => "frontier"),
  }
})

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn().mockResolvedValue(null),
  updateProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/progress/read-validation-count", () => ({
  readValidationCount: vi.fn(() => 1),
  readValidationCountAudio: vi.fn(() => 1),
}))

vi.mock("@/lib/store/user-api-keys", () => ({
  setUserApiKey: vi.fn(),
  useUserApiKey: vi.fn(() => null),
}))

vi.mock("@/lib/metrics/use-post-edit-metrics", () => ({
  usePostEditMetrics: () => ({
    metrics: null,
    isLoading: false,
    isError: false,
    revalidate: vi.fn(),
  }),
}))

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [],
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(),
    add: vi.fn(),
    addMany: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
    changeRole: vi.fn(),
  }),
}))

vi.mock("@/hooks/useProjectOrgId", () => ({
  useProjectOrgId: () => null,
}))

const rosterSettings = vi.hoisted(() => ({ canViewRoster: true }))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    settings: {},
    orgRules: [],
    promotionRequests: [],
    canRequestPromotion: false,
    version: 1,
    hasFetched: true,
    canEdit: true,
    canEditOrgKeys: true,
    orgProviderKeys: {},
    canExport: true,
    exportMinRole: null,
    canViewRoster: rosterSettings.canViewRoster,
    rosterViewMinRole: 600,
    canViewMemberProgress: true,
    memberProgressViewMinRole: 600,
    allowSelfAssignment: false,
    termbaseEditMinRole: 500,
    refresh: vi.fn(async () => null),
    patch: vi.fn(async () => ({ kind: "ok" as const, value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })),
    requestPromotion: vi.fn(async () => ({ kind: "blocked" as const })),
  }),
}))

vi.mock("@/context/OrgContext", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/context/OrgContext")>()
  return {
    ...original,
    useActiveOrgOptional: () => null,
  }
})

vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: () => ({
    query: "",
    results: [],
    isLoading: false,
    needsMorePrefix: true,
    lastFetchOk: true,
  }),
}))

// Catch-all landing recorder: the moved-section redirects leave the settings
// routes entirely, so any non-settings destination falls through to this probe
// and exposes exactly where (path + search) the redirect landed.
function LandingProbe() {
  const location = useLocation()
  return <div data-testid="landing-path">{`${location.pathname}${location.search}`}</div>
}

function renderAt(path: string) {
  cleanup()
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
        <Route path="*" element={<LandingProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderModalAt(path: string) {
  cleanup()
  const backgroundLocation = {
    pathname: `/projects/${PROJECT_ID}`,
    search: "",
    hash: "",
    state: null,
    key: "project-overview",
  }
  return render(
    <MemoryRouter
      initialIndex={1}
      initialEntries={[
        backgroundLocation,
        {
          pathname: path,
          state: { backgroundLocation, projectSettingsModalDepth: 1 },
        },
      ]}
    >
      <Routes>
        <Route path="/projects/:id" element={<div data-testid="project-overview-background" />} />
        <Route path="/project/:id/settings" element={<ProjectSettingsDialog />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettingsDialog />} />
        <Route path="*" element={<LandingProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  rosterSettings.canViewRoster = true
})

describe("ProjectSettings — sub-menu IA (AQU-501)", () => {
  it("renders the shared settings UI in a route-backed modal and closes to its origin", () => {
    renderModalAt(`/project/${PROJECT_ID}/settings`)

    const dialog = screen.getByTestId("project-settings-dialog")
    expect(dialog).toHaveClass("max-w-[min(42rem,calc(100%-2rem))]")
    fireEvent.click(screen.getByText("General"))
    fireEvent.change(screen.getByLabelText(/project title/i), {
      target: { value: "Unsaved modal title" },
    })

    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(screen.getByRole("heading", { name: "Discard changes?" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(screen.getByTestId("project-overview-background")).toBeTruthy()
  })

  it("only expands the modal beyond the content width for wide settings panes", () => {
    renderModalAt(`/project/${PROJECT_ID}/settings`)

    fireEvent.click(screen.getByText("Members"))

    expect(screen.getByTestId("project-settings-dialog")).toHaveClass(
      "max-w-[min(72rem,calc(100%-2rem))]",
    )
  })

  it("index (no ?section=) shows labeled sub-menus, not the full control set", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)

    // The index is a NavList of groups...
    expect(screen.getByText("General")).toBeTruthy()
    expect(screen.getByText("Members")).toBeTruthy()
    expect(screen.getByText("AI & completion")).toBeTruthy()
    expect(screen.getByText("Validation & health")).toBeTruthy()
    // ...minus the sections that moved to the standalone Living Memory
    // surface (/project/:id/memory) — they must NOT be index rows anymore.
    // The Quality hub still renders with Validation & health alone.
    expect(screen.queryByText("Rules")).toBeNull()
    expect(screen.queryByText("Living Memory")).toBeNull()

    // Index hints show the current value, capitalized — not the raw enum
    // ("reviewer", "lazy") dumped before opening the pane.
    expect(screen.getByText("Reviewer")).toBeTruthy()
    expect(screen.getByText("Lazy (default)")).toBeTruthy()

    // ...not the controls themselves. Project Title (General) and AI
    // Instructions (AI & completion) must NOT both be in the document at once
    // on the index — proving this isn't still one long scroll.
    expect(screen.queryByLabelText(/project title/i)).toBeNull()
    expect(screen.queryByLabelText(/username/i)).toBeNull()
  })

  it("picking a sub-menu renders only that group's controls", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)

    fireEvent.click(screen.getByText("General"))

    // General's own controls are present...
    expect(screen.getByLabelText(/project title/i)).toBeTruthy()
    expect(screen.getByLabelText(/username/i)).toBeTruthy()

    // ...but a control that lives in a different group (AI & completion) is
    // NOT rendered at the same time. This is the core "no more one long
    // scroll" assertion — every field used to be simultaneously in the DOM.
    expect(screen.queryByLabelText(/examples retrieved/i)).toBeNull()
    expect(screen.queryByRole("switch", { name: /allow self-validation/i })).toBeNull()
  })

  it("a `?section=` deep link renders directly into that pane", () => {
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    expect(screen.getByLabelText(/examples retrieved/i)).toBeTruthy()
    expect(screen.queryByLabelText(/project title/i)).toBeNull()
  })

  it("the Settings breadcrumb returns to the settings index", () => {
    renderAt(`/project/${PROJECT_ID}/settings/general`)
    expect(screen.getByLabelText(/project title/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("link", { name: /^Settings$/i }))

    expect(screen.getByText("AI & completion")).toBeTruthy()
    expect(screen.queryByLabelText(/project title/i)).toBeNull()
  })

  it("omits Editor from the breadcrumb unless settings was opened from the editor", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)
    expect(screen.getByTestId("org-breadcrumb")).not.toHaveTextContent("Editor")

    renderAt(`/project/${PROJECT_ID}/settings?return=/project/${PROJECT_ID}/editor`)
    expect(screen.getByTestId("org-breadcrumb")).toHaveTextContent("Editor")
  })

  it("keeps the Editor crumb when opening a pane from an editor handoff", () => {
    renderAt(`/project/${PROJECT_ID}/settings?return=/project/${PROJECT_ID}/editor`)
    fireEvent.click(screen.getByText("General"))

    expect(screen.getByTestId("org-breadcrumb")).toHaveTextContent("Editor")
    expect(screen.getByRole("link", { name: /^Settings$/i })).toHaveAttribute(
      "href",
      `/project/${PROJECT_ID}/settings?return=${encodeURIComponent(`/project/${PROJECT_ID}/editor`)}`,
    )
  })

  it("search results are grouped under main section headers", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)

    const search = screen.getByLabelText(/search settings/i)
    fireEvent.change(search, { target: { value: "language" } })

    // Matching cards appear under their index section label — not a flat dump.
    expect(screen.getByText("General")).toBeTruthy()
    expect(screen.getByLabelText(/project title/i)).toBeTruthy()
    // Unrelated groups that have no keyword match stay out of the document.
    expect(screen.queryByText("AI metrics")).toBeNull()
    expect(screen.queryByText(/approved ai review effort/i)).toBeNull()
  })

  // No setting lost: every section that used to live on the single scroll is
  // still reachable through exactly one sub-menu pane.
  it("every settings group renders its expected controls (no section dropped)", () => {
    renderAt(`/project/${PROJECT_ID}/settings/general`)
    expect(screen.getByLabelText(/project title/i)).toBeTruthy()
    expect(screen.getByRole("switch", { name: /enable bible resources/i })).toBeTruthy()
    expect(screen.getByLabelText(/username/i)).toBeTruthy()
    // Form panes stay on Page size="default" (max-w-2xl, left-aligned).
    expect(screen.getByLabelText(/project title/i).closest(".max-w-2xl")).toBeTruthy()
    expect(screen.getByLabelText(/project title/i).closest(".max-w-6xl")).toBeNull()

    renderAt(`/project/${PROJECT_ID}/settings/members`)
    expect(screen.getByTestId("settings-members-section")).toBeTruthy()
    expect(screen.getByRole("button", { name: /add a member/i })).toBeTruthy()
    // Table panes use Page size="wide" (max-w-6xl) and hide the settings search
    // (the roster DataTable has its own member search).
    expect(
      screen.getByTestId("settings-members-section").closest(".max-w-6xl"),
    ).toBeTruthy()
    expect(screen.queryByLabelText(/search settings/i)).toBeNull()
    expect(screen.getByLabelText(/search by name or email/i)).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings/source-sync`)
    // This project has a git origin but no source link, so only Git Sync
    // renders in this pane — confirms the group still mounts correctly when
    // some of its member sections are conditionally hidden.
    // PageHeader description also mentions "git sync", so match the card title exactly.
    expect(screen.getByText("Git Sync")).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings/ai`)
    // The system prompt moved to Living Memory (memory/instructions) — the AI
    // pane cross-links there instead of nesting a settings pane, and no
    // system-prompt textarea exists anywhere in settings anymore.
    expect(screen.getByRole("link", { name: /living memory/i })).toBeTruthy()
    expect(screen.queryByLabelText(/^system prompt$/i)).toBeNull()
    expect(screen.getByLabelText(/examples retrieved/i)).toBeTruthy()
    expect(screen.getByLabelText(/preceding committed-target cells/i)).toBeTruthy()
    expect(screen.getByText(/^voice$/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /open terminology library/i })).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings/validation`)
    expect(screen.getByLabelText(/required validators \(text\)/i)).toBeTruthy()
    expect(screen.getByText(/^harmonization$/i)).toBeTruthy()
    expect(screen.getByText(/retrieval support/i)).toBeTruthy()
    // Retrieval support sits under Validation + Harmonization on this pane.
    const validationHeading = screen.getByText(/^validation$/i)
    const retrievalHeading = screen.getByText(/retrieval support/i)
    expect(
      validationHeading.compareDocumentPosition(retrievalHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings/audio-media`)
    expect(screen.getByText(/audio loading/i)).toBeTruthy()
    // Pre-merge round: the timing-mode card LEFT this pane — the mode is
    // file-level now, controlled from the Media timeline's toolbar.
    expect(screen.queryByTestId("settings-timing-mode")).toBeNull()

    renderAt(`/project/${PROJECT_ID}/settings/metrics`)
    // PostEditMetricsSection renders its own heading regardless of loading state.
    expect(screen.getByText(/approved ai review effort/i)).toBeTruthy()

    // rules / memory / system-prompt are NOT panes anymore — their legacy URLs
    // redirect to the Living Memory surface (covered by the redirect tests).
  })

  // Living Memory extraction: legacy section URLs must keep working — deep
  // links exist in the wild (the server-sent `settings/memory` readiness href,
  // RuleDrawer's `settings/rules?ruleId=…`) — by redirecting to the standalone
  // /project/:id/memory surface with the query string preserved.
  it("redirects the legacy settings/memory URL to the memory surface", () => {
    renderAt(`/project/${PROJECT_ID}/settings/memory`)
    expect(screen.getByTestId("landing-path").textContent).toBe(
      `/project/${PROJECT_ID}/memory`,
    )
  })

  it("redirects the legacy settings/rules URL to memory/quality, preserving search", () => {
    renderAt(`/project/${PROJECT_ID}/settings/rules?q=x`)
    expect(screen.getByTestId("landing-path").textContent).toBe(
      `/project/${PROJECT_ID}/memory/quality?q=x`,
    )
  })

  it("redirects the legacy settings/system-prompt URL to memory/instructions, from the route-modal too", () => {
    renderAt(`/project/${PROJECT_ID}/settings/system-prompt`)
    expect(screen.getByTestId("landing-path").textContent).toBe(
      `/project/${PROJECT_ID}/memory/instructions`,
    )

    // The modal presentation redirects identically (no dialog shell renders).
    renderModalAt(`/project/${PROJECT_ID}/settings/system-prompt`)
    expect(screen.getByTestId("landing-path").textContent).toBe(
      `/project/${PROJECT_ID}/memory/instructions`,
    )
    expect(screen.queryByTestId("project-settings-dialog")).toBeNull()
  })

  // Entry point kept alive: the AI pane cross-links to Living Memory where
  // the system prompt now lives, reusing the old Custom/Default hint. It is a
  // plain navigation (no modal state) since it leaves settings entirely.
  it("the AI pane shows a Living Memory cross-link with a Default hint by default", () => {
    renderAt(`/project/${PROJECT_ID}/settings/ai`)

    const link = screen.getByRole("link", { name: /living memory/i })
    expect(link).toHaveAttribute("href", `/project/${PROJECT_ID}/memory/instructions`)
    expect(link).toHaveTextContent("Default")
  })

  // The hidden termbase-sharing section (SHOW_TERMBASE_SHARING_IN_SETTINGS
  // flag) must stay hidden the same way it was pre-AQU-501 — not surfaced as
  // its own sub-menu group or NavRow.
  it("termbase sharing stays hidden behind its feature flag", () => {
    renderAt(`/project/${PROJECT_ID}/settings`)
    expect(screen.queryByText(/term base sharing/i)).toBeNull()

    renderAt(`/project/${PROJECT_ID}/settings/ai`)
    expect(screen.queryByText(/term base sharing/i)).toBeNull()
  })

  it("hides the Members settings pane when the caller is below the roster floor", () => {
    rosterSettings.canViewRoster = false
    renderAt(`/project/${PROJECT_ID}/settings`)

    expect(screen.queryByRole("link", { name: "Members" })).toBeNull()
    expect(screen.getByText("General")).toBeTruthy()

    renderAt(`/project/${PROJECT_ID}/settings/members`)
    // Unknown/hidden pane falls back to the index — no roster, no disclosure.
    expect(screen.queryByTestId("settings-members-section")).toBeNull()
    expect(screen.queryByText(/roster hidden/i)).toBeNull()
    expect(screen.getByText("General")).toBeTruthy()
  })
})
