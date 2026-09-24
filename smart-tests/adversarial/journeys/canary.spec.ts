import { test, expect } from "@playwright/test"
import { v7 as uuidv7 } from "uuid"
import { authenticatedPage, editorUrl } from "../../fixture"
import { Workspace } from "../../../e2e/helpers/page-objects/Workspace"
import { mintSyncToken } from "../../../e2e/helpers/seed-project"
import { OUTBOX_SCHEMA_VERSION } from "../../../src/lib/sync/outbox-types"
import { verifyInvariants, type Contract } from "../invariants"
import { readRunContext, readSnapshot, seedFixture } from "../state"

/*
 * The health gate. No model runs here. Attacks depend on this project, so
 * if either check fails no attack runs and no ticket can be filed: a dead
 * harness reports HARNESS UNAVAILABLE instead of false product findings.
 */
const seen = { inputObserved: true, mutatorApplied: true, serverErrors: 0, pageErrors: 0 }

async function fixture(label: string) {
  const run = readRunContext()
  const owner = run.sessions[0]
  const { seeded } = await seedFixture(owner, { name: `adv canary ${label} ${uuidv7().slice(-6)}`, orgId: run.orgId, members: [] })
  const contract: Contract = {
    allowed: [{ kind: "target", cellId: seeded.cellIds[0] }],
    required: [{ kind: "target-value", cellId: seeded.cellIds[0], oneOf: [`Canary ${seeded.projectId.slice(0, 6)}`] }],
  }
  const readers = [{ projectId: seeded.projectId, reader: owner }]
  return { run, owner, seeded, contract, readers, expected: `Canary ${seeded.projectId.slice(0, 6)}` }
}

async function attachEvidence(testInfo: import("@playwright/test").TestInfo, body: Record<string, unknown>) {
  await testInfo.attach("smart-testing-evidence", {
    body: JSON.stringify({ adversarial: true, canary: true, ...body }), contentType: "application/json",
  })
}

test("canary: a scripted real edit passes the oracle", async ({ browser }, testInfo) => {
  const { owner, seeded, contract, readers, expected } = await fixture("edit")
  const before = await readSnapshot(readers)
  const { page, context } = await authenticatedPage(browser, owner, seeded)
  try {
    await page.goto(editorUrl(seeded))
    const workspace = new Workspace(page)
    await workspace.waitForEditor(seeded.cellIds[0])
    // Replace the seeded translation the way Jev's fill does: select all, then type.
    await workspace.activateTargetCell(0)
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type(expected)
    // Leave the editor open until the idle commit reaches the server.
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      const stored = (await readSnapshot(readers)).cells
        .find((cell) => cell.cellId === seeded.cellIds[0] && cell.side === "target")?.value
      if (stored === expected) break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  } finally {
    await context.close()
  }
  let outcome = verifyInvariants(before, before, contract, seen)
  for (const deadline = Date.now() + 20_000; Date.now() < deadline && outcome.verdict !== "passed";) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    outcome = verifyInvariants(before, await readSnapshot(readers), contract, seen)
  }
  await attachEvidence(testInfo, { check: "real-edit", outcome, projects: [{ projectId: seeded.projectId, owner: owner.username }] })
  expect(outcome.verdict, outcome.reason).toBe("passed")
})

test("canary: a planted wrong-row write is rejected", async () => {
  const testInfo = test.info()
  const { owner, seeded, contract, readers, expected } = await fixture("planted")
  const before = await readSnapshot(readers)
  const wrongCell = seeded.cellIds[1]
  const head = before.cells.find((cell) => cell.cellId === wrongCell && cell.side === "target")?.eventId ?? null
  const token = await mintSyncToken(owner.jwt, seeded.projectId, seeded.fileId)
  const response = await fetch(`${process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST}`}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: [{
      id: uuidv7(), schemaVersion: OUTBOX_SCHEMA_VERSION, kind: "target.cell.commit",
      projectId: seeded.projectId, fileId: seeded.fileId, cellId: wrongCell, parentId: head,
      author: owner.username, payload: { value: expected }, clientTs: Date.now(),
    }] }),
  })
  expect(response.ok).toBe(true)
  const outcome = verifyInvariants(before, await readSnapshot(readers), contract, seen)
  await attachEvidence(testInfo, { check: "planted-wrong-row", outcome, projects: [{ projectId: seeded.projectId, owner: owner.username }] })
  expect(outcome.verdict).toBe("product_failure")
  expect(outcome.diffs).toContain(`cell ${seeded.fileId}/${wrongCell}/target changed`)
})
