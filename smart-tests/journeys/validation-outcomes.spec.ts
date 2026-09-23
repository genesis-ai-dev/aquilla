import { test, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { buildIdentity } from "../build"
import {
  prepareValidation, authenticatedPage, editorUrl, targetSurface, validationButton,
} from "../fixture"
import { runJev, JEV_REVISION, type AgentRun } from "../driver"
import { readProjectedCells, readSeededFileEvents } from "../../e2e/helpers/seed-project"
import { verifiedOutcome } from "../project-oracle"
import { translationsUntouched, validationLanded, validationLogClean } from "../validation-oracle"
import type { Outcome } from "../outcome"
import { observeDom } from "../dom"

async function selfValidated(page: Page, cellId: string): Promise<boolean> {
  const button = validationButton(page, cellId)
  return await button.count() === 1 && await button.getAttribute("aria-pressed") === "true"
}

// A reviewer signs off on one finished translation. The adverse condition
// tears the document down the moment the control flips, before the outbox
// can flush — a reviewer closing the tab after the last approval of the day.
for (const condition of ["normal", "immediate-departure"] as const) {
  test(`Jev validation sign-off: ${condition}`, async ({ browser }, testInfo) => {
    const fixture = await prepareValidation()
    const { seeded, session, contract } = fixture
    const { page, context } = await authenticatedPage(browser, session, seeded)
    const rowNumber = seeded.cellIds.indexOf(contract.cellId) + 1
    const goal = `In project "${seeded.projectName}", file "${seeded.fileName}", `
      + `approve the translation of row ${rowNumber} only, the row whose source reads `
      + `"Keep this third paragraph unchanged too.". Mark that one translation as validated. `
      + "Do not approve any other row, and do not change any translation text."
    let inputObserved = false
    let departureApplied = false
    let agent: AgentRun | null = null
    let outcome: Outcome = { verdict: "inconclusive", checks: {}, reason: "Verification did not complete." }
    let pageErrors = 0
    let initialDom: Awaited<ReturnType<typeof observeDom>> | null = null
    let server: { rows: unknown; events: unknown } | null = null
    page.on("pageerror", () => { pageErrors++ })
    const { build, dirty, trackedDiffHash, harnessBuild } = buildIdentity()
    try {
      await page.goto(editorUrl(seeded))
      await expect(targetSurface(page, contract.cellId)).toBeVisible({ timeout: 30_000 })
      await expect(validationButton(page, contract.cellId)).toBeVisible({ timeout: 30_000 })
      initialDom = await observeDom(page)
      agent = await runJev(page, goal, {
        onEvidence: (value) => { agent = value },
        onAction: async (action) => {
          if (action.kind !== "click") return false
          // Read the intended row's own control, never the clicked element.
          if (!await selfValidated(page, contract.cellId)) return false
          inputObserved = true
          if (condition !== "immediate-departure") return false
          await page.goto("about:blank")
          departureApplied = true
          return true
        },
      })
      // A real teardown discards the in-memory editor; only the durable
      // outbox can carry the sign-off. Reopen the writer so it may.
      if (departureApplied) {
        await page.goto(editorUrl(seeded))
        await expect(validationButton(page, contract.cellId)).toBeVisible({ timeout: 30_000 })
      }
      const deadline = Date.now() + 10_000
      let rows = await readProjectedCells(session.jwt, seeded)
      while (inputObserved && !validationLanded(contract, rows) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        rows = await readProjectedCells(session.jwt, seeded)
      }
      const events = await readSeededFileEvents(session.jwt, seeded.projectId, seeded.fileId)
      server = { rows, events: events.map(({ id, kind, author }) => ({ id, kind, author })) }
      const fresh = await authenticatedPage(browser, session, seeded)
      let freshVisible = false
      try {
        await fresh.page.goto(editorUrl(seeded))
        await expect(validationButton(fresh.page, contract.cellId)).toBeVisible({ timeout: 30_000 })
        // A bounded UI wait records a false check, not a second attempt.
        freshVisible = await validationButton(fresh.page, contract.cellId)
          .and(fresh.page.locator('[aria-pressed="true"]'))
          .waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)
      } finally { await fresh.context.close() }
      outcome = verifiedOutcome({
        durableValidation: validationLanded(contract, rows),
        signOffLogClean: validationLogClean(contract, events),
        translationsUntouched: translationsUntouched(contract, rows),
        freshSession: freshVisible,
        noPageErrors: pageErrors === 0,
      }, inputObserved)
      if (["driver_error", "timed_out", "budget_exhausted"].includes(agent.status)
        && outcome.verdict === "passed") {
        outcome = { ...outcome, verdict: "inconclusive", reason: `Driver stopped: ${agent.status}` }
      }
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ verdict: "passed" })
      if (condition === "immediate-departure") expect(departureApplied).toBe(true)
    } finally {
      await testInfo.attach("smart-testing-evidence", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        schemaVersion: 1, journey: "validation-sign-off", condition,
        build, dirty, trackedDiffHash, harnessBuild, jevRevision: JEV_REVISION,
        runId: fixture.runId, projectId: seeded.projectId, fileId: seeded.fileId,
        goal, contract, inputObserved, departureApplied, agent, outcome, server,
        pageErrors, initialDom,
      })) })
      await context.close()
    }
  })
}
