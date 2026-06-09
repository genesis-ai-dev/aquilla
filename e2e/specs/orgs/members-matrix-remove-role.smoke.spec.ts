import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, addProjectMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MembersMatrixCellEditor — "Remove from project" in the role edit popover.
 *
 * When a member already has a role on a project, the matrix cell shows an
 * "Edit <username>'s role on this project" button. Clicking it opens a
 * Popover with a role picker and a "Remove from project" button.
 * Clicking "Remove from project" removes the member, reverting the cell
 * to the empty "Add <username> to project" state.
 *
 * This spec: seeds bob in alice's org → adds bob directly to a project
 * via API → navigates to Matrix view → finds bob's edit cell for that
 * project → clicks it → clicks "Remove from project" → verifies the
 * "Add bob to project" affordance reappears.
 */
test("matrix view remove member from project via cell editor", async ({ alice, bob }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Alice creates a project.
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MatrixRemove ${Date.now()}`
  await dash.createProject({ name })

  // Get project ID from the URL after creation.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Add bob to the project via API (faster than UI flow).
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.CONTRIBUTOR)

  // Navigate to members page → Matrix view.
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  const matrixBtn = alice.getByRole("button", { name: /Matrix/i })
  await expect(matrixBtn).toBeVisible({ timeout: 10_000 })
  await matrixBtn.click()

  // The cell for bob on this project shows "Edit bob's role on this project".
  const editCell = alice.getByRole("button", { name: /Edit bob('s| ) role on/i }).first()
  await expect(editCell).toBeVisible({ timeout: 10_000 })
  await editCell.click()

  // Popover opens with role picker + "Remove from project" button.
  const removeBtn = alice.getByRole("button", { name: /Remove from project/i })
  await expect(removeBtn).toBeVisible({ timeout: 5_000 })
  await removeBtn.click()

  // Cell reverts to the empty "Add bob" state.
  const addBackCell = alice.getByRole("button", { name: /Add bob to/i }).first()
  await expect(addBackCell).toBeVisible({ timeout: 8_000 })
})
