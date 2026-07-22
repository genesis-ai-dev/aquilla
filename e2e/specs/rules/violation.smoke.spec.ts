import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Verify built-in rule enable + violation surfacing.
 *
 * The "double-space" check has display name "Extra whitespace" (per
 * src/lib/lqa/builtin-registry.ts). The rules page uses an `aria-label`
 * of `${def.name} enabled` for each toggle. A cell with violations
 * tints the cell number pill amber/red as the single issue surface.
 */
// Fixed: use keyboard.insertText() instead of keyboard.type() for the
// double-space cell text — insertText dispatches a single input event
// rather than individual keydown/keypress/keyup events, so ProseMirror
// does not normalize consecutive spaces away.
test("alice enables 'Extra whitespace' rule and sees a violation surfaced in editor", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Rules ${Date.now()}` })
  const projectId = seeded.projectId

  // Enable the built-in rule on the rules page (shadcn Switch, role="switch").
  await alice.goto(`/project/${projectId}/rules`)
  const toggle = alice.getByRole("switch", { name: /Extra whitespace enabled/i })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 3_000 })
  }

  // Back to the server-seeded workspace and type a violation. The helper uses
  // the same Markdown parser and fixture as the real import journey, so retain
  // the structural-heading numbering guard without repeating UI setup here.
  const ws = await openSeededProject(alice, seeded)
  // Markdown headings are structural cells and intentionally have no line
  // number. Exercise the first numbered content cell so this rule journey
  // also guards the heading-vs-content numbering contract.
  await expect(ws.cellRow(0).getByLabel(/^Line /)).toHaveCount(0)
  const contentRow = ws.cellRow(1)
  await expect(contentRow.getByLabel("Line 1")).toBeVisible()
  // Use insertText (not keyboard.type) to preserve consecutive spaces through
  // ProseMirror — type() fires individual key events that get normalized.
  await ws.activateTargetCell(1)
  // Preserve the source's `e2e` number and terminal period so the only
  // infraction introduced by this test is the minor whitespace rule.
  await alice.keyboard.insertText("this  has  double  spaces in e2e.") // intentional doubles
  await alice.locator("aside").click() // blur
  await alice.waitForTimeout(2_000)

  // The cell number is the issue surface and tints amber for minor infractions.
  const linePill = contentRow.locator('[aria-label="Line 1"] span').first()
  await expect(linePill).toHaveClass(/text-amber-600/, { timeout: 10_000 })
})
