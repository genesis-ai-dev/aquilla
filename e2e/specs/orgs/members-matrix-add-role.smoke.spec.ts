import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MembersMatrixCellEditor — add a project role for an org member.
 *
 * The Members page Matrix view renders one row per org member and one
 * column per project. Empty cells (no project access) show a "+" aria-label
 * button ("Add <username> to project"). Clicking opens a Popover with role
 * picker options. Picking a role adds the member to the project.
 *
 * This spec: seeds bob in alice's org → creates a project → navigates to
 * /members → switches to Matrix view → finds the empty cell for bob/project →
 * clicks "+ Add bob to project" → picks "Contributor" → verifies the cell
 * no longer shows the empty "Add" affordance.
 */
test("matrix view add member to project via role picker", async ({ alice, bob }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Alice creates a project.
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MatrixRole ${Date.now()}`
  await dash.createProject({ name })

  // Navigate to members page → Matrix view.
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Switch to Matrix view.
  const matrixBtn = alice.getByRole("button", { name: /Matrix/i })
  await expect(matrixBtn).toBeVisible({ timeout: 10_000 })
  await matrixBtn.click()

  // Find the empty cell for bob on the new project (aria-label="Add bob to project").
  const addBobCell = alice.getByRole("button", { name: /Add bob to/i }).first()
  await expect(addBobCell).toBeVisible({ timeout: 10_000 })
  await addBobCell.click()

  // Role picker popover appears.
  const pickerPopover = alice.getByText(/Add bob/i).first()
  await expect(pickerPopover).toBeVisible({ timeout: 5_000 })

  // Select "Contributor" role.
  const contributorOption = alice.getByRole("button", { name: /Contributor/i }).first()
  await expect(contributorOption).toBeVisible({ timeout: 3_000 })
  await contributorOption.click()

  // After adding, the "Add bob" button should disappear (replaced by an edit affordance).
  await expect(addBobCell).not.toBeVisible({ timeout: 8_000 })
})
