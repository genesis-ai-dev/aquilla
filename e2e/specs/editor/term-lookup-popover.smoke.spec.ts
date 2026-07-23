import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * TermLookupPopover — source-cell word matching a terminology concept.
 *
 * EditorTable.tsx wraps source-cell tokens matching a concept entry in a
 * <TermLookupPopover> — the span gets a dotted underline and, when clicked,
 * opens the popover (aria-label="Terminology lookup for "<word>"").
 *
 * sample.md includes the word "content" in plain-paragraph cell text. We add
 * a terminology concept for "content" in the project, then open the editor
 * and verify:
 *   1. The word "content" in the source column has a dotted-underline span.
 *   2. Clicking it opens the popover.
 *   3. The popover is visible with the term name.
 *
 * NOTE: the concept word must come from an UNFORMATTED cell. Cells with
 * inline formatting carry `originalHtml` and render via sanitized HTML
 * (EditorTable.tsx), which bypasses SourceWithTermLookup entirely — so the
 * bolded "sample" cell never gets the underline affordance.
 */
test("term lookup popover appears for terminology-matched source word", async ({ alice }) => {
  // Terminology round-trip + editor open can exceed the 30s harness budget
  // under load.
  test.slow()
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TermPopover ${Date.now()}` })

  const glossary = new Glossary(alice)
  await glossary.goto(seeded.projectId)
  await glossary.addTerm("content", "échantillon")

  await openSeededProject(alice, seeded)

  // Find the dotted-underline span for "content" in the source column.
  // TermLookupPopover wraps the word in a span with cursor-pointer + underline.
  const termSpan = alice
    .locator("span.cursor-pointer.underline")
    .filter({ hasText: /^content$/i })
    .first()
  await expect(termSpan).toBeVisible({ timeout: 10_000 })

  // Click to open the popover.
  await termSpan.click()

  // Popover with aria-label "Terminology lookup for "content"" opens.
  const popover = alice.locator('[aria-label*="Terminology lookup"]')
  await expect(popover).toBeVisible({ timeout: 5_000 })
})
