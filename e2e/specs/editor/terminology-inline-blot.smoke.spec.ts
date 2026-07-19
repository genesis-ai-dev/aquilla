import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Glossary } from "../../helpers/page-objects/Glossary"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AQU-664 — terminology violations surface ONLY via the inline blot.
 *
 * A forbidden rendering used to raise TWO signals: an amber "Terminology
 * advisory" band AND the inline `violation-blot-term` decoration, and the blot
 * only appeared after the ~1.2s commit-idle debounce. AQU-664:
 *   - removed the amber band (one signal, not two),
 *   - recomputes the terminology blot off the LIVE buffer so it appears while
 *     the cell is still being edited (before any commit/blur), and
 *   - shows the rule explanation on hover ("wave over") and dismisses it on
 *     mouse-out.
 *
 * Setup: a concept sourceTerm="sample", rendering="verboten" (forbidden),
 * status active. Import sample.md, activate the target cell, type "verboten",
 * and — crucially — stay focused (do NOT blur) so we exercise the live editor
 * blot, not the committed read-view highlight.
 */
test("terminology violation shows the inline blot (no advisory band), explained on hover", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermBlot ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("sample", "verboten")
  await glossary.setRenderingStatus("sample", "forbidden")

  // Import sample.md and open the editor.
  await alice.goto(`/project/${projectId}/editor`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Type the forbidden rendering into cell 1 and STAY focused (no blur) — the
  // blot must light up off the live buffer, ahead of the commit.
  await ws.activateTargetCell(1)
  await alice.keyboard.type("verboten")

  // The inline terminology blot appears on the offending text…
  const blot = alice.locator(".ProseMirror .violation-blot-term").filter({ hasText: "verboten" })
  await expect(blot.first()).toBeVisible({ timeout: 10_000 })

  // …and the amber advisory band does NOT (it was removed).
  await expect(
    alice.locator('[role="status"]').filter({ hasText: /Terminology advisory/i }),
  ).toHaveCount(0)

  // Hovering ("waving over") the blot shows the rule explanation.
  await blot.first().hover()
  const explanation = alice.getByText(/forbidden rendering|forbidden pattern/i)
  await expect(explanation.first()).toBeVisible({ timeout: 5_000 })

  // Moving off the blot dismisses the explanation reliably (no stuck popover).
  await alice.mouse.move(2, 2)
  await expect(explanation).toHaveCount(0, { timeout: 5_000 })
})
