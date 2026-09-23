import { test, expect } from "@playwright/test"
import { buildIdentity } from "../build"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { runJev, JEV_REVISION, type AgentRun } from "../driver"
import {
  prepareEdit, authenticatedPage, editorUrl, targetSurface, verifyInFreshSession,
} from "../fixture"
import type { Outcome } from "../outcome"

for (const condition of ["normal", "immediate-departure", "delayed-network"] as const) {
  test(`Jev edit durability: ${condition}`, async ({ browser }, testInfo) => {
    const fixture = await prepareEdit()
    const { seeded, contract, session } = fixture
    const { page, context } = await authenticatedPage(browser, session, seeded)
    const goal = `Open project "${seeded.projectName}" and file "${seeded.fileName}". `
      + `In the first translation cell, beside "Welcome to the translation project.", `
      + `replace the translation with exactly "${contract.expected}". `
      + "Save your work by leaving the cell. Do not modify other cells."
    let inputObserved = false
    let departureApplied = false
    let agent: AgentRun | null = null
    let outcome: Outcome = {
      verdict: "inconclusive", checks: {}, reason: "The run did not complete verification.",
    }
    const diagnostics: { kind: string; path?: string; status?: number }[] = []
    // Allowlist URLs to paths only: sync queries and websocket URLs carry JWTs.
    page.on("pageerror", () => diagnostics.push({ kind: "pageerror" }))
    page.on("response", (response) => {
      if (response.status() >= 400) diagnostics.push({
        kind: "http_error", path: new URL(response.url()).pathname, status: response.status(),
      })
    })
    page.on("requestfailed", (request) => diagnostics.push({
      kind: "requestfailed", path: new URL(request.url()).pathname,
    }))
    const output = testInfo.outputPath("evidence.json")
    mkdirSync(path.dirname(output), { recursive: true })
    const { build, dirty, trackedDiffHash, harnessBuild } = buildIdentity()
    const save = () => writeFileSync(output, JSON.stringify({
      schemaVersion: 1, journey: "edit-durability", condition,
      build, dirty, trackedDiffHash, harnessBuild,
      jevRevision: JEV_REVISION, runId: fixture.runId,
      projectId: seeded.projectId, fileId: seeded.fileId,
      goal, contract, inputObserved, departureApplied, agent, outcome, diagnostics,
    }, null, 2))
    try {
      await page.goto("/app")
      await expect(page.getByText(seeded.projectName, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
      if (condition === "delayed-network") {
        const network = await context.newCDPSession(page)
        await network.send("Network.enable")
        // A deliberate network condition, never a readiness sleep. This
        // delays HTTP and connection setup; it does not delay websocket frames.
        await network.send("Network.emulateNetworkConditions", {
          offline: false, latency: 1000, downloadThroughput: 750_000, uploadThroughput: 250_000,
        })
      }
      agent = await runJev(page, goal, {
        onEvidence: (value) => { agent = value; save() },
        onAction: async (action) => {
          if (action.kind !== "fill") return false
          // Check the exact intended cell, not whichever field received input.
          const surface = targetSurface(page, contract.cellId).locator(".ProseMirror")
          if (await surface.count() !== 1) return false
          inputObserved = (await surface.innerText()).trim() === contract.expected
          if (inputObserved && condition === "immediate-departure") {
            await page.goto("about:blank")
            departureApplied = true
            return true
          }
          return false
        },
      })
      // Reopen the writer after a real document teardown. Its durable outbox
      // may recover; the discarded editor's in-memory buffer cannot.
      if (departureApplied) {
        await page.goto(editorUrl(seeded))
        await expect(targetSurface(page, contract.cellId)).toBeVisible({ timeout: 30_000 })
      }
      outcome = await verifyInFreshSession(browser, fixture, inputObserved)
      if (["driver_error", "timed_out", "budget_exhausted"].includes(agent.status)
        && outcome.verdict === "passed") {
        outcome = { ...outcome, verdict: "inconclusive", reason: `Driver stopped: ${agent.status}` }
      }
      if (diagnostics.some((event) => event.kind === "pageerror") && outcome.verdict === "passed") {
        outcome = { ...outcome, verdict: "product_failure", reason: "The browser raised an uncaught application error." }
      }
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ verdict: "passed" })
      if (condition === "immediate-departure") expect(departureApplied).toBe(true)
    } finally {
      save()
      await testInfo.attach("smart-testing-evidence", { path: output, contentType: "application/json" })
      await context.close()
    }
  })
}
