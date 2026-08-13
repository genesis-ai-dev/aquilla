import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TVars } from "@/lib/i18n/translate"
import type { ContextualOverview, ProjectRunStartResult } from "@/lib/contextual/transport"
import { ExperimentalFlagsSection } from "@/components/ProjectSettings/ExperimentalFlagsSection"
import { ProjectAutopilotPanel } from "./ProjectAutopilotPanel"

const mocks = vi.hoisted(() => ({
  fetchOverview: vi.fn<() => Promise<ContextualOverview>>(),
  startProject: vi.fn<() => Promise<ProjectRunStartResult>>(),
}))

vi.mock("@/lib/i18n/I18nProvider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/i18n/I18nProvider")>(
    "@/lib/i18n/I18nProvider",
  )
  const { en } = await vi.importActual<typeof import("@/lib/i18n/messages/en")>(
    "@/lib/i18n/messages/en",
  )
  const { interpolate, translate } = await vi.importActual<typeof import("@/lib/i18n/translate")>(
    "@/lib/i18n/translate",
  )
  const replacements: Partial<Record<MessageKey, string>> = {
    "autopilot.overview.widget.reviewAria": "مراجعة {count} اقتراحات",
    "autopilot.settings.experimentalTitle": "ميزات تجريبية",
    "autopilot.settings.experimentalDescription": "ميزات محلية على هذا الجهاز.",
    "autopilot.settings.controlsLabel": "إظهار عناصر تحكم Autopilot",
    "autopilot.settings.controlsDescription": "عناصر التحكم هذه لا تبدأ العمل.",
  }
  const t = (key: MessageKey, vars?: TVars) => {
    const replacement = replacements[key]
    return replacement
      ? interpolate(replacement, vars)
      : translate(en, key, vars, "ar")
  }
  return {
    ...actual,
    useI18n: () => ({
      locale: "ar",
      dir: "rtl" as const,
      locales: [],
      setLocale: vi.fn(),
      t,
    }),
  }
})

vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualOverview: () => mocks.fetchOverview(),
  startProjectContextualRun: () => mocks.startProject(),
}))

vi.mock("@/components/contextual/AutopilotActivityInspector", () => ({
  AutopilotActivityInspector: () => null,
}))

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => undefined),
  patchProject: vi.fn(async () => true),
  updateProject: vi.fn(async () => undefined),
}))

const overview: ContextualOverview = {
  available: true,
  files: [],
  activeRuns: 0,
  doneSpans: 0,
  totalSpans: 0,
  failedSpans: 0,
  unitsSpent: 0,
  proposedDrafts: 0,
  appliedDrafts: 0,
}

describe("localized Autopilot overview and settings wiring", () => {
  beforeEach(() => {
    mocks.fetchOverview.mockReset()
    mocks.fetchOverview.mockResolvedValue(overview)
    mocks.startProject.mockReset()
    mocks.startProject.mockResolvedValue({
      scope: "project",
      scopeGroup: "group-1",
      started: [{ runId: "run-1", fileId: "file-1" }],
      skipped: [{ fileId: "file-2", reason: "already running" }],
      totalCandidates: 2,
      deferred: { count: 0, reason: null },
      truncated: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("uses translated ARIA text and the active locale for dates and result lists", async () => {
    vi.useFakeTimers()
    const checkedAt = new Date("2026-08-11T13:05:00.000Z")
    vi.setSystemTime(checkedAt)
    const localizedTime = new Intl.DateTimeFormat("ar", { timeStyle: "short" }).format(checkedAt)

    render(
      <ProjectAutopilotPanel
        projectId="project-1"
        fileNames={new Map()}
        canStart
      />,
    )
    await act(async () => { await Promise.resolve() })

    expect(screen.getByRole("button", { name: "مراجعة 0 اقتراحات" })).toBeInTheDocument()
    expect(screen.getByText(`Checked ${localizedTime}`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Run Autopilot" }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(screen.getByText(/1 file started و1 file skipped/)).toBeInTheDocument()
  })

  it("resolves feature-flag metadata through its typed message keys", async () => {
    render(<ExperimentalFlagsSection projectId="project-1" />)

    expect(screen.getByText("ميزات تجريبية")).toBeInTheDocument()
    expect(screen.getByText("ميزات محلية على هذا الجهاز.")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "إظهار عناصر تحكم Autopilot" })).toBeChecked()
    expect(screen.getByText("عناصر التحكم هذه لا تبدأ العمل.")).toBeInTheDocument()
  })
})
