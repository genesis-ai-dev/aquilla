import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

interface PersistedActivityEvent {
  kind: string
  status?: string
  phase?: string
  summary: string
  details: { count?: number }
}

interface RunActivityResponse {
  run: { status: string } | null
  events: PersistedActivityEvent[]
  sceneBriefs: unknown[]
  drafts: unknown[]
}

function runRecord(
  runId: string,
  fileId: string,
  patch: { status?: string; proposedDrafts?: number; updatedAt?: string } = {},
) {
  return {
    runId,
    fileId,
    targetLang: "",
    status: patch.status ?? "terminated",
    phase: null,
    spanLabel: null,
    done: 0,
    total: 1,
    failed: 0,
    unitsSpent: 0,
    callsSpent: 0,
    lastError: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: patch.updatedAt ?? "2026-08-11T10:00:00.000Z",
    activeDirections: [],
    proposedDrafts: patch.proposedDrafts ?? 0,
  }
}

/**
 * Project-overview Autopilot observability.
 *
 * This is intentionally separate from contextual/run-pill.smoke.spec.ts: the
 * editor spec owns one-file controls and steering, while this spec owns the
 * PM journey from the compact project card into durable run evidence.
 *
 * The OpenRouter calls are server-side and use scripts/mock-openrouter.ts's
 * deterministic [[ctx:*]] responses. No browser-side model stub is involved.
 */
test("project overview shows autopilot start, outcome, and durable activity", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Overview autopilot ${Date.now()}` })
  const authBase = process.env.VITE_AUTH_BASE ?? ""
  expect(authBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

  const overviewPath = `/api/v2/projects/${seeded.projectId}/contextual/overview`
  const initialOverview = alice.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === overviewPath
  })
  await alice.goto(`/projects/${seeded.projectId}`)
  expect((await initialOverview).ok()).toBe(true)

  // The idle surface is a summary, not the old always-expanded table/checklist.
  const panel = alice.getByTestId("project-autopilot-panel")
  await expect(panel).toBeVisible()
  await expect(panel.getByRole("heading", { name: "Autopilot" })).toBeVisible()
  const runButton = panel.getByRole("button", { name: "Run Autopilot" })
  await expect(runButton).toBeVisible()
  await expect(panel).toContainText("Not started")
  await expect(panel).toContainText(/Ready to run/i)
  await expect(panel.getByRole("table")).toHaveCount(0)
  await expect(panel.getByRole("list")).toHaveCount(0)

  // Hold the real request at the network boundary. That makes the transient
  // acknowledgement deterministic without replacing the server pipeline or
  // waiting for an arbitrary number of milliseconds.
  const runsPath = `/api/v2/projects/${seeded.projectId}/contextual/runs`
  const runsGlob = `**${runsPath}`
  let releaseStart!: () => void
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve
  })
  await alice.route(runsGlob, async (route) => {
    if (route.request().method() === "POST") await startGate
    await route.continue()
  })

  const started = alice.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "POST" && url.pathname === runsPath
  })
  const startedResponse = await (async () => {
    try {
      await runButton.click()
      await expect(panel.getByRole("status")).toContainText(/Starting autopilot/i)
      releaseStart()
      // Let the held handler finish `route.continue()` before removing it;
      // unroute otherwise auto-handles the pending route and creates a
      // misleading "Route is already handled" failure.
      return await started
    } finally {
      releaseStart()
      await alice.unroute(runsGlob)
    }
  })()

  expect(startedResponse.status()).toBe(201)
  const startBody = (await startedResponse.json()) as {
    started: Array<{ runId: string; fileId: string }>
  }
  const startedRun = startBody.started.find((run) => run.fileId === seeded.fileId)
  expect(startedRun, "project-wide start should include the seeded discourse file").toBeTruthy()
  const runId = startedRun!.runId

  // The new activity endpoint is the durable authority for this inspector.
  // Wait until it records both the parked outcome and generated evidence; the
  // callback retries API state, never elapsed time or an optional UI branch.
  const activityUrl = `${authBase}${runsPath}/${encodeURIComponent(runId)}/activity`
  let activity: RunActivityResponse | null = null
  await expect.poll(async () => {
    const response = await alice.request.get(activityUrl, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!response.ok()) {
      return {
        status: `HTTP ${response.status()}`,
        progressed: false,
        staged: false,
        evidence: false,
      }
    }
    activity = (await response.json()) as RunActivityResponse
    const stagedCount = activity.events
      .filter((event) => event.kind === "drafts_staged")
      .reduce((total, event) => total + (event.details.count ?? 0), 0)
    return {
      status: activity.run?.status ?? "missing",
      progressed:
        activity.events.some((event) => event.kind === "phase" && event.phase === "drafting") &&
        activity.events.some(
          (event) => event.kind === "run_state" && event.status === "parked",
        ),
      staged: stagedCount > 0 && stagedCount === activity.drafts.length,
      evidence: activity.sceneBriefs.length > 0,
    }
  }, {
    message: "wait for the real pipeline to park with persisted activity evidence",
    timeout: 30_000,
  }).toEqual({ status: "parked", progressed: true, staged: true, evidence: true })

  expect(activity).not.toBeNull()
  const stagedEvent = activity!.events.find((event) => event.kind === "drafts_staged")
  expect(stagedEvent?.summary).toBeTruthy()

  // The card must catch up to the same truth: a parked run is Idle with no
  // work queued, while its generated drafts are Ready to review (not still
  // "working").
  await expect(panel).toContainText(/\bIdle\b/i, { timeout: 30_000 })
  await expect(panel).toContainText(/No more work is queued/i)
  const draftCount = activity!.drafts.length
  await expect(
    panel.getByRole("button", { name: `View ${draftCount} ready to review` }),
  ).toBeVisible()

  await panel.getByRole("button", { name: "View activity" }).click()
  const activitySheet = alice.getByRole("dialog", { name: "Autopilot activity" })
  await expect(activitySheet).toBeVisible()
  await expect(activitySheet).toContainText(/\bIdle\b/i)
  await expect(activitySheet.getByLabel("Autopilot step history")).toContainText(
    stagedEvent!.summary,
  )

  // A parked run is still controllable. Stopping it must invalidate the
  // project snapshot immediately so the PM sees a terminal, startable card
  // without reloading the page.
  const terminatePath = `${runsPath}/${encodeURIComponent(runId)}/terminate`
  const terminated = alice.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "POST" && url.pathname === terminatePath
  })
  const refreshedOverview = alice.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === overviewPath
  })
  await activitySheet.getByRole("button", { name: "Stop" }).click()
  expect((await terminated).ok()).toBe(true)
  expect((await refreshedOverview).ok()).toBe(true)
  await expect(activitySheet.getByText("This run was stopped.", { exact: true })).toBeVisible()
  await activitySheet.getByRole("button", { name: "Close" }).click()
  await expect(activitySheet).not.toBeVisible()
  await expect(panel).not.toContainText(/\bIdle\b/i)
  await expect(panel).toContainText(/Ready for review/i)
  await expect(panel.getByRole("button", { name: "Run Autopilot" })).toBeVisible()
})

test("review count selects the historical run that owns its proposed evidence", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Overview review owner ${Date.now()}` })
  const newestRunId = "01920000-0000-7000-8000-000000000002"
  const evidenceRunId = "01920000-0000-7000-8000-000000000001"
  const overviewPath = `/api/v2/projects/${seeded.projectId}/contextual/overview`
  const runsPath = `/api/v2/projects/${seeded.projectId}/contextual/runs`
  const newestRun = runRecord(newestRunId, seeded.fileId, {
    updatedAt: "2026-08-11T10:02:00.000Z",
  })
  const evidenceRun = runRecord(evidenceRunId, seeded.fileId, {
    status: "parked",
    proposedDrafts: 2,
    updatedAt: "2026-08-11T10:01:00.000Z",
  })
  const recentRuns = Array.from({ length: 50 }, (_, index) => runRecord(
    index === 0 ? newestRunId : `01920000-0000-7000-8001-${String(index).padStart(12, "0")}`,
    seeded.fileId,
    { updatedAt: `2026-08-11T10:${String(59 - index).padStart(2, "0")}:00.000Z` },
  ))
  const evidenceText = "Evidence from the historical run that owns these suggestions."

  await alice.route(`**${overviewPath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        files: [{
          fileId: seeded.fileId,
          runId: newestRunId,
          targetLang: "",
          status: "terminated",
          doneSpans: 0,
          totalSpans: 1,
          failedSpans: 0,
          unitsSpent: 0,
          // File rows describe their newest run. The project total below can
          // still include proposed evidence owned by an older run.
          proposedDrafts: 0,
          appliedDrafts: 0,
          updatedAt: newestRun.updatedAt,
          lastError: null,
        }],
        activeRuns: 0,
        doneSpans: 0,
        totalSpans: 1,
        failedSpans: 0,
        unitsSpent: 0,
        proposedDrafts: 2,
        appliedDrafts: 0,
      }),
    })
  })
  await alice.route(`**${runsPath}**`, async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== "GET") {
      await route.fallback()
      return
    }
    if (url.pathname === runsPath) {
      const proposedOnly = url.searchParams.get("proposedOnly") === "true"
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          // The evidence owner is beyond normal history's first 50 rows. The
          // indexed proposed-only view must find it without serially walking
          // unrelated run pages.
          runs: proposedOnly ? [evidenceRun] : recentRuns,
          truncated: !proposedOnly,
          nextCursor: proposedOnly
            ? null
            : { createdAt: recentRuns[49].createdAt, runId: recentRuns[49].runId },
        }),
      })
      return
    }
    const activityMatch = url.pathname.match(/\/contextual\/runs\/([^/]+)\/activity$/)
    if (!activityMatch) {
      await route.fallback()
      return
    }
    const runId = decodeURIComponent(activityMatch[1])
    const ownsEvidence = runId === evidenceRunId
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: ownsEvidence ? evidenceRun : newestRun,
        events: [],
        sceneBriefs: [],
        drafts: ownsEvidence
          ? [
              { id: "draft-1", runId, fileId: seeded.fileId, cellId: "cell-1", text: evidenceText, status: "proposed" },
              { id: "draft-2", runId, fileId: seeded.fileId, cellId: "cell-2", text: "Second owned suggestion.", status: "proposed" },
            ]
          : [],
        draftCounts: ownsEvidence
          ? { proposed: 2, applied: 0, rejected: 0, superseded: 0 }
          : { proposed: 0, applied: 0, rejected: 0, superseded: 0 },
        draftNextCursor: null,
        truncatedCollections: { events: false, sceneBriefs: false, drafts: false },
        truncated: false,
      }),
    })
  })

  await alice.goto(`/projects/${seeded.projectId}`)
  const panel = alice.getByTestId("project-autopilot-panel")
  const reviewCount = panel.getByRole("button", { name: "View 2 ready to review" })
  await expect(reviewCount).toBeVisible()
  await reviewCount.click()

  const activitySheet = alice.getByRole("dialog", { name: "Autopilot activity" })
  await expect(activitySheet.getByText(evidenceText, { exact: true })).toBeVisible()
  await activitySheet.getByRole("button", { name: "Run details" }).click()
  await expect(activitySheet.getByText(evidenceRunId, { exact: true })).toBeVisible()
  await expect(activitySheet).not.toContainText("No draft records were returned for this run.")
})
