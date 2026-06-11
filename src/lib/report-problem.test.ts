/**
 * FRO-307: Tests for report-problem payload assembly and consent-off path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import * as analyticsConsent from "@/lib/analytics-consent"

// Mock posthog before importing the module under test
vi.mock("@/lib/posthog", () => ({
  default: {
    capture: vi.fn(),
    get_session_replay_url: vi.fn(() => "https://app.posthog.com/replay/session-abc"),
  },
}))

import posthog from "@/lib/posthog"
import {
  captureReportProblem,
  buildReportText,
  getSessionReplayUrl,
  REPORT_PROBLEM_EVENT,
  type ReportProblemPayload,
} from "./report-problem"

const baseContext = { route: "/project/proj-1/file/file-2", projectId: "proj-1", fileId: "file-2" }
const basePayload: ReportProblemPayload = {
  description: "Something broke",
  context: baseContext,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("captureReportProblem", () => {
  it("sends the event when analytics are enabled and returns true", () => {
    vi.spyOn(analyticsConsent, "isAnalyticsEnabled").mockReturnValue(true)

    const sent = captureReportProblem(basePayload)

    expect(sent).toBe(true)
    expect(posthog.capture).toHaveBeenCalledWith(
      REPORT_PROBLEM_EVENT,
      expect.objectContaining({
        description: "Something broke",
        route: baseContext.route,
        project_id: "proj-1",
        file_id: "file-2",
      }),
    )
  })

  it("does NOT call posthog.capture when analytics are off and returns false", () => {
    vi.spyOn(analyticsConsent, "isAnalyticsEnabled").mockReturnValue(false)

    const sent = captureReportProblem(basePayload)

    expect(sent).toBe(false)
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it("includes the session replay URL in the captured event", () => {
    vi.spyOn(analyticsConsent, "isAnalyticsEnabled").mockReturnValue(true)

    captureReportProblem({
      ...basePayload,
      sessionReplayUrl: "https://app.posthog.com/replay/abc",
    })

    expect(posthog.capture).toHaveBeenCalledWith(
      REPORT_PROBLEM_EVENT,
      expect.objectContaining({
        session_replay_url: "https://app.posthog.com/replay/abc",
      }),
    )
  })

  it("falls back to getSessionReplayUrl() when no URL provided explicitly", () => {
    vi.spyOn(analyticsConsent, "isAnalyticsEnabled").mockReturnValue(true)

    captureReportProblem(basePayload)

    expect(posthog.capture).toHaveBeenCalledWith(
      REPORT_PROBLEM_EVENT,
      expect.objectContaining({
        session_replay_url: "https://app.posthog.com/replay/session-abc",
      }),
    )
  })
})

describe("buildReportText", () => {
  it("includes route, project, file, and description", () => {
    const text = buildReportText(basePayload)
    expect(text).toContain("Route: /project/proj-1/file/file-2")
    expect(text).toContain("Project: proj-1")
    expect(text).toContain("File: file-2")
    expect(text).toContain("Something broke")
  })

  it("omits project/file lines when not present", () => {
    const text = buildReportText({ description: "bug", context: { route: "/dashboard" } })
    expect(text).not.toContain("Project:")
    expect(text).not.toContain("File:")
    expect(text).toContain("Route: /dashboard")
  })
})

describe("getSessionReplayUrl", () => {
  it("returns the URL from posthog.get_session_replay_url", () => {
    const url = getSessionReplayUrl()
    expect(url).toBe("https://app.posthog.com/replay/session-abc")
  })

  it("returns null when the method is missing (e.g., recording disabled)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (posthog as any).get_session_replay_url
    const url = getSessionReplayUrl()
    expect(url).toBeNull()
  })
})
