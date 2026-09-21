import { test, expect } from "@playwright/test"
import { readProjectedCells } from "../../e2e/helpers/seed-project"
import { Workspace } from "../../e2e/helpers/page-objects/Workspace"
import { prepareEdit, authenticatedPage, editorUrl, verifyInFreshSession } from "../fixture"
import { verifyEdit } from "../outcome"

test("oracle qualification: rejects a missing write and accepts a real durable edit", async ({ browser }, testInfo) => {
  const fixture = await prepareEdit()
  const { session, seeded, contract } = fixture
  const { page, context } = await authenticatedPage(browser, session, seeded)
  try {
    await page.goto(editorUrl(seeded))
    const workspace = new Workspace(page)
    await workspace.waitForEditor(contract.cellId)
    // Known broken outcome: visible optimistic text alone must never pass.
    const missingWrite = verifyEdit(contract,
      await readProjectedCells(session.jwt, seeded), contract.expected, true)
    expect(missingWrite.verdict).toBe("product_failure")
    expect(missingWrite.checks.durableTarget).toBe(false)

    await workspace.editCell(0, contract.expected)
    const realEdit = await verifyInFreshSession(browser, fixture, true)
    expect(realEdit.verdict).toBe("passed")
    // Reverse the durable outcome to model a lost/incorrect projection.
    const wrongProjection = verifyEdit(contract,
      realEdit.rows.map((row) => row.side === "target" ? { ...row, value: "lost edit" } : row),
      realEdit.freshVisible, true)
    expect(wrongProjection.verdict).toBe("product_failure")
    await testInfo.attach("oracle-qualification", {
      body: JSON.stringify({ missingWrite, realEdit, wrongProjection }, null, 2),
      contentType: "application/json",
    })
  } finally {
    await context.close()
  }
})
