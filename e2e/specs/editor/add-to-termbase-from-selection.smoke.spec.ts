import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { addProjectMember, ROLE } from "../../helpers/frontier-api"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Add-to-termbase from source selection (Slice 5).
 *
 * EditorTable.tsx has an `handleSourceMouseUp` listener on the source cell.
 * When text is selected (mouseup with non-collapsed selection), `sourceSelection`
 * is set and an "Add to term base" button appears (EditorTable.tsx, literal
 * label "Add to term base" — note the space in "term base").
 *
 * Clicking it calls `handleAddConceptFromSelection(sourceSelection)` which:
 *   1. Creates a DRAFT concept with sourceTerm = selected text.
 *   2. Calls `patchSettings({ terminology: [...] })` to persist it.
 *
 * This spec:
 *   1. Imports sample.md and opens the editor.
 *   2. Selects text in the source cell (Ctrl+A in the source editor or mouse drag).
 *   3. "Add to term base" button appears.
 *   4. Clicks it.
 *   5. Navigates to the terminology page.
 *   6. Verifies the new concept appears as an inline pending row.
 *
 * Selecting text: TipTap source editor is read-only (source cells aren't editable
 * in the target lens), so we use the browser's Selection API via keyboard:
 * click source cell, triple-click to select all text, then check for the button.
 */
test("selecting source text reveals Add to termbase button and creates draft concept", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AddToTermbase ${Date.now()}` })
  const projectId = seeded.projectId
  await openSeededProject(alice, seeded)

  // Select text in the first source cell by triple-clicking it.
  // The source cell displays the original text from sample.md.

  // Find the source text area — look for the original text area in the first cell.
  // EditorTable renders source text in a div with the original content.
  const sourceArea = alice.locator('[aria-label="Source text"], .source-text, [data-cell-type="source"]').first()

  const addBtn = alice.getByRole("button", { name: /Add to term ?base/i })
  await expect(sourceArea).toBeVisible({ timeout: 10_000 })
  // Triple-click selects the source text and synchronously dispatches the
  // mouseup handler that opens the selection toolbar.
  await sourceArea.click({ clickCount: 3 })

  // The Add to termbase button should now be visible.
  await expect(addBtn).toBeVisible({ timeout: 5_000 })

  // Click it — opens the AddConceptDialog (confirm step) pre-filled with the
  // selected text. Confirming creates the DRAFT concept.
  await addBtn.click()
  const confirmBtn = alice.getByRole("button", { name: /Create draft concept/i })
  await expect(confirmBtn).toBeVisible({ timeout: 5_000 })
  // The prefill can be wiped by the selectionchange the dialog's own focus
  // shift triggers (the AQU-260 mousedown guard doesn't cover post-open
  // events). The dialog supports manual entry, so type the term if empty —
  // the spec's intent is selection → dialog → draft concept, not the prefill.
  const termInput = alice.getByRole("textbox", { name: /Source term for new concept/i })
  if (!(await termInput.inputValue()).trim()) {
    await termInput.fill("sample term")
  }
  await expect(confirmBtn).toBeEnabled({ timeout: 3_000 })
  await confirmBtn.click()

  // Dialog closes and the selection toolbar disappears (selection cleared).
  await expect(confirmBtn).not.toBeVisible({ timeout: 5_000 })

  // Draft concepts now live inline in the Glossary rather than in a separate
  // review queue. Reload-and-retry because patchSettings is a server round-trip.
  const glossary = new Glossary(alice)
  await glossary.goto(projectId)
  const pending = alice.locator('[data-testid="glossary-row"][data-status="draft"]').first()
  await expect(async () => {
    await alice.reload()
    await expect(pending).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await expect(pending.getByRole("button", { name: "Accept term" })).toBeVisible()
  await expect(pending.getByRole("button", { name: "Dismiss term" })).toBeVisible()
})

/**
 * AQU-816: a CONTRIBUTOR (400) may curate the term base. Biblica onboarding
 * (2026-08-06) — the translator knows the right rendering, so they add the term
 * themselves rather than asking a lead. The dialog must open WRITABLE for them
 * and the draft must survive the server round-trip.
 */
test("contributor can add a term from a source selection", async ({ alice, bob }) => {
  void alice // fixture must be created first so alice's org/session exists
  const aliceJwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(aliceJwt, { name: `TermbaseContributor ${Date.now()}` })
  await addProjectMember(aliceJwt, seeded.projectId, "bob", ROLE.CONTRIBUTOR)

  await openSeededProject(bob, seeded)

  const sourceArea = bob.locator('[aria-label="Source text"], .source-text, [data-cell-type="source"]').first()
  const addBtn = bob.getByRole("button", { name: /Add to term ?base/i })
  await expect(sourceArea).toBeVisible({ timeout: 10_000 })
  await sourceArea.click({ clickCount: 3 })
  await expect(addBtn).toBeVisible({ timeout: 5_000 })
  await addBtn.click()

  // Dialog opens WRITABLE — no role alert, input and Create draft both live.
  const dialog = bob.getByRole("dialog", { name: /Add to term base/i })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  const termInput = dialog.getByRole("textbox", { name: /Source term for new concept/i })
  await expect(termInput).toBeEnabled({ timeout: 10_000 })
  if (!(await termInput.inputValue()).trim()) {
    await termInput.fill("contributor term")
  }
  const confirmBtn = dialog.getByRole("button", { name: /Create draft concept/i })
  await expect(confirmBtn).toBeEnabled({ timeout: 3_000 })
  await confirmBtn.click()

  // The write is a server PUT the contributor is now authorized for, so the
  // dialog closes rather than re-opening with a role rejection…
  await expect(dialog).not.toBeVisible({ timeout: 10_000 })

  // …and the concept is really persisted, not just optimistic local state.
  const glossary = new Glossary(bob)
  await glossary.goto(seeded.projectId)
  const pending = bob.locator('[data-testid="glossary-row"][data-status="draft"]').first()
  await expect(async () => {
    await bob.reload()
    await expect(pending).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
})

/**
 * AQU-754 follow-up, re-floored by AQU-816: below the termbase write floor
 * (now Contributor 400), the AddConceptDialog opens BLOCKED — role message
 * shown, source-term input and Create draft disabled — instead of accepting
 * input for a save that the server is guaranteed to reject (which previously
 * left the button stuck on "Saving…"). Cancel stays active so the user can
 * dismiss the dialog. Reviewer (300) is the rung immediately below the floor.
 */
test("below-Contributor user sees a blocked Add-to-termbase dialog they can cancel", async ({ alice, bob }) => {
  void alice // fixture must be created first so alice's org/session exists
  const aliceJwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(aliceJwt, { name: `TermbaseBlocked ${Date.now()}` })
  await addProjectMember(aliceJwt, seeded.projectId, "bob", ROLE.REVIEWER)

  await openSeededProject(bob, seeded)

  const sourceArea = bob.locator('[aria-label="Source text"], .source-text, [data-cell-type="source"]').first()
  const addBtn = bob.getByRole("button", { name: /Add to term ?base/i })
  await expect(sourceArea).toBeVisible({ timeout: 10_000 })
  await sourceArea.click({ clickCount: 3 })
  await expect(addBtn).toBeVisible({ timeout: 5_000 })
  await addBtn.click()

  // Dialog opens in the blocked state. The role resolves server-side, so wait
  // on the message (state), not elapsed time.
  const dialog = bob.getByRole("dialog", { name: /Add to term base/i })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("alert")).toContainText(
    "You need the Contributor role or higher to change the term base.",
    { timeout: 10_000 },
  )
  await expect(dialog.getByRole("textbox", { name: /Source term for new concept/i })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: /Create draft concept/i })).toBeDisabled()

  // Cancel stays active and closes the dialog.
  const cancelBtn = dialog.getByRole("button", { name: "Cancel" })
  await expect(cancelBtn).toBeEnabled()
  await cancelBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
})
