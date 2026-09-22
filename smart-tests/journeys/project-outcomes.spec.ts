import { test, expect } from "@playwright/test"
import { buildIdentity } from "../build"
import { prepareEdit, authenticatedPage, editorUrl, targetSurface } from "../fixture"
import { runJev, JEV_REVISION, type AgentRun } from "../driver"
import { mintSyncToken, readProjectedCells } from "../../e2e/helpers/seed-project"
import { cellsUnchanged, commentMatches, verifiedOutcome } from "../project-oracle"
import type { Outcome } from "../outcome"
import type { CommentRecord } from "../../src/lib/sync/comments-read-types"
import { observeDom } from "../dom"

for (const journey of ["project-rename", "file-rename", "cell-comment"] as const) {
  test(`Jev project outcome: ${journey}`, async ({ browser }, testInfo) => {
    const fixture = await prepareEdit()
    const { seeded, session, contract } = fixture
    const expected = `${journey} ${fixture.runId.slice(0, 8)}`
    const { page, context } = await authenticatedPage(browser, session, seeded)
    const token = await mintSyncToken(session.jwt, seeded.projectId, seeded.fileId)
    const projectPath = `/api/v1/projects/${seeded.projectId}`
    const get = async <T,>(url: string, bearer: string): Promise<T> => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } })
      if (!response.ok) throw new Error(`Oracle read failed: HTTP ${response.status}`)
      return await response.json() as T
    }
    const readState = async () => {
      const project = await get<{ id: string; name: string }>(
        `${process.env.VITE_FRONTIER_BASE}/api/v2/projects/${seeded.projectId}`, session.jwt)
      const origin = `http://${process.env.VITE_SYNC_WORKER_HOST}`
      const { file } = await get<{ file: { fileId: string; name: string } }>(
        `${origin}${projectPath}/files/${seeded.fileId}`, token)
      // Fresh fixture has no comments. Read project-wide to catch wrong-cell writes
      // and duplicates, rather than filtering those mistakes out of the oracle.
      const comments = await get<{ comments: CommentRecord[]; nextCursor?: string | null }>(
        `${origin}${projectPath}/comments?limit=200`, token)
      if (comments.nextCursor) throw new Error("Unexpected comment pagination in isolated fixture")
      return { project, file, comments: comments.comments }
    }
    const initial = await readState()
    const goal = journey === "project-rename"
      ? `Rename project "${seeded.projectName}" to exactly "${expected}". Save the change. Keep its files and translations unchanged.`
      : journey === "file-rename"
        ? `Rename file "${seeded.fileName}" in project "${seeded.projectName}" to exactly "${expected}". Save the change. Keep the project name and all translations unchanged.`
        : `In project "${seeded.projectName}", file "${seeded.fileName}", use the first row's More actions menu to add one cell comment beside "Welcome to the translation project.". Post exactly "${expected}". Keep all translations unchanged.`
    let inputObserved = false
    let agent: AgentRun | null = null
    let outcome: Outcome = { verdict: "inconclusive", checks: {}, reason: "Verification did not complete." }
    let server: Awaited<ReturnType<typeof readState>> | null = null
    let pageErrors = 0
    let initialDom: Awaited<ReturnType<typeof observeDom>> | null = null
    page.on("pageerror", () => { pageErrors++ })
    const { build, dirty, trackedDiffHash, harnessBuild } = buildIdentity()
    try {
      await page.goto(journey === "project-rename" ? "/app" : editorUrl(seeded))
      if (journey === "project-rename") {
        await expect(page.getByText(seeded.projectName, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
      } else {
        await expect(targetSurface(page, contract.cellId)).toBeVisible({ timeout: 30_000 })
      }
      initialDom = await observeDom(page)
      agent = await runJev(page, goal, {
        onEvidence: (value) => { agent = value },
        onAction: async (action) => {
          if (action.kind === "fill") {
            // Observe actual DOM values; the policy's reported text is no oracle.
            inputObserved ||= await page.locator("input, textarea").evaluateAll(
              (elements, value) => elements.some((element) =>
                (element as HTMLInputElement).value === value), expected)
          }
          return false
        },
      })
      const achieved = (state: Awaited<ReturnType<typeof readState>>) => journey === "project-rename"
        ? state.project.name === expected : journey === "file-rename"
          ? state.file.name === expected : state.comments.some((comment) => comment.body === expected)
      const deadline = Date.now() + 10_000
      server = await readState()
      while (inputObserved && !achieved(server) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        server = await readState()
      }
      const fresh = await authenticatedPage(browser, session, seeded)
      let freshVisible = false
      try {
        await fresh.page.goto(journey === "project-rename" ? "/app"
          : journey === "cell-comment" ? `/project/${seeded.projectId}/comments` : editorUrl(seeded))
        await expect(fresh.page.locator('[aria-busy="true"]:visible')).toHaveCount(0)
        // A bounded UI wait records a false check, not a second attempt at the journey.
        freshVisible = await fresh.page.getByText(expected, { exact: true }).first()
          .waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)
      } finally { await fresh.context.close() }
      outcome = verifiedOutcome({
        durableOutcome: achieved(server), freshSession: freshVisible,
        projectIdentity: server.project.id === seeded.projectId,
        fileIdentity: server.file.fileId === seeded.fileId,
        projectName: server.project.name === (journey === "project-rename" ? expected : initial.project.name),
        fileName: server.file.name === (journey === "file-rename" ? expected : initial.file.name),
        commentScope: journey === "cell-comment"
          ? commentMatches(server.comments, { body: expected, projectId: seeded.projectId,
            fileId: seeded.fileId, cellId: contract.cellId })
          : server.comments.length === initial.comments.length,
        cellsUnchanged: cellsUnchanged(contract.baseline, await readProjectedCells(session.jwt, seeded)),
        noPageErrors: pageErrors === 0,
      }, inputObserved)
      if (["driver_error", "timed_out", "budget_exhausted"].includes(agent.status)) {
        outcome = { ...outcome, verdict: "inconclusive", reason: `Driver stopped: ${agent.status}` }
      }
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ verdict: "passed" })
    } finally {
      await testInfo.attach("smart-testing-evidence", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        schemaVersion: 1, journey, build, dirty, trackedDiffHash, harnessBuild, jevRevision: JEV_REVISION,
        runId: fixture.runId, projectId: seeded.projectId, fileId: seeded.fileId,
        goal, expected, inputObserved, agent, outcome, server, pageErrors, initialDom,
      })) })
      await context.close()
    }
  })
}
