import { expect } from "@playwright/test"
import { Workspace } from "../../../helpers/page-objects/Workspace"
import { tutorial } from "../../tutorials/tutorial"

/** John 1:2: translated in the demo, validated by nobody yet. */
const VERSE = 1

tutorial("validate-a-verse", async (t) => {
  const { page, show } = t
  const ws = new Workspace(page)
  const row = ws.cellRow(VERSE)
  const ring = ws.validationToggle(VERSE)
  // The app wraps its numbers in bidi isolates: match round them.
  const unvalidated = page.getByText(/unvalidated$/).first()

  await expect(unvalidated).toContainText(/5\W* unvalidated/)
  await t.say("intro")

  await t.closeUp(row, async () => {
    await show.point(row.locator('[data-showcase="editor.source"]').first())
    await show.point(row.locator('[data-showcase="editor.target"]').first())
    await t.say("read")

    await show.point(ring)
    await t.say("ring")
    // The cursor shows the click; the page object makes it, the way the
    // validation smoke does (a pointer click can lose a race with the ring's
    // own tooltip and be ignored).
    await show.click(ring, { real: false })
    await ws.validateCell(VERSE)
    await expect(ring).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 })
    await t.say("done")
  }, 1.4)

  await expect(unvalidated).toContainText(/4\W* unvalidated/, { timeout: 10_000 })
  await t.closeUp(unvalidated, async () => {
    await show.point(unvalidated)
    await t.say("count")
  })

  await show.point(ring)
  await t.say("outro")
})
