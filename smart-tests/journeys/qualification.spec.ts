import { test, expect } from "@playwright/test"
import { readProjectedCells } from "../../e2e/helpers/seed-project"
import { Workspace } from "../../e2e/helpers/page-objects/Workspace"
import { readSeededFileEvents } from "../../e2e/helpers/seed-project"
import {
  prepareEdit, prepareValidation, authenticatedPage, editorUrl, verifyInFreshSession,
  validationButton,
} from "../fixture"
import { verifyEdit } from "../outcome"
import { translationsUntouched, validationLanded, validationLogClean } from "../validation-oracle"

/** Poll an authoritative read until it satisfies the contract, or expire.
 * Expiry records the failed contract; it never retries the gesture. */
async function pollFor<T>(read: () => Promise<T>, satisfied: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000
  let value = await read()
  while (!satisfied(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    value = await read()
  }
  return value
}

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

test("oracle qualification: rejects an unsigned and a misplaced validation, accepts a real sign-off", async ({ browser }, testInfo) => {
  const fixture = await prepareValidation()
  const { session, seeded, contract } = fixture
  const { page, context } = await authenticatedPage(browser, session, seeded)
  try {
    await page.goto(editorUrl(seeded))
    const button = validationButton(page, contract.cellId)
    await expect(button).toBeVisible({ timeout: 30_000 })
    // Known broken outcome: a translated but unsigned file must never pass.
    expect(validationLanded(contract, contract.baseline)).toBe(false)
    expect(validationLogClean(contract,
      await readSeededFileEvents(session.jwt, seeded.projectId, seeded.fileId))).toBe(false)

    await button.click()
    await expect(button).toHaveAttribute("aria-pressed", "true")
    const rows = await pollFor(() => readProjectedCells(session.jwt, seeded),
      (value) => validationLanded(contract, value))
    const events = await readSeededFileEvents(session.jwt, seeded.projectId, seeded.fileId)
    const real = {
      durableValidation: validationLanded(contract, rows),
      signOffLogClean: validationLogClean(contract, events),
      translationsUntouched: translationsUntouched(contract, rows),
    }
    expect(real).toEqual({
      durableValidation: true, signOffLogClean: true, translationsUntouched: true,
    })
    // Move the sign-off to a neighbour to model a wrong-cell projection.
    const misplaced = rows.map((row) => row.side === "target"
      ? { ...row, validated: row.cellId !== contract.cellId } : row)
    expect(validationLanded(contract, misplaced)).toBe(false)
    expect(translationsUntouched(contract, misplaced)).toBe(false)
    await testInfo.attach("oracle-qualification", {
      body: JSON.stringify({ real, rows, misplaced,
        events: events.map(({ id, kind, author }) => ({ id, kind, author })) }, null, 2),
      contentType: "application/json",
    })
  } finally {
    await context.close()
  }
})
