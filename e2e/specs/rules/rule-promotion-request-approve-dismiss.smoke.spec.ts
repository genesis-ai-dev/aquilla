import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * RulesSurface — org maintainer approves / dismisses a promotion request.
 *
 * When a project_lead user requests promotion of a project rule (via
 * "Request promotion" button), a pending request appears in the org
 * maintainer's rules panel under "Pending promotion requests".
 *
 * The maintainer sees "Approve" and "Dismiss" per request.
 *
 * This spec tests the Dismiss path (it's non-destructive and doesn't
 * require further DB state):
 *   1. Bob (PROJECT_LEAD in org) navigates to the rules page and requests
 *      promotion for a rule.
 *   2. Alice (org owner) refreshes her rules page and sees the pending
 *      request panel.
 *   3. Alice clicks "Dismiss" — the request disappears.
 */
test("Org owner can dismiss a rule promotion request", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  // Add bob as PROJECT_LEAD in the org.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.PROJECT_LEAD)

  // Alice creates a project and adds bob as maintainer so he can create rules.
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `PromoApprove ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()

  const { addProjectMember } = await import("../../helpers/frontier-api")
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.MAINTAINER)

  // Bob creates a rule and requests promotion.
  await bob.goto(`/project/${projectId}/rules`)
  await bob.waitForLoadState("networkidle")

  const addRuleBtn = bob.getByRole("button", { name: /Add Rule|New rule|Add rule/i }).first()
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const ruleName = `BobRule ${Date.now()}`
  const nameInput = bob.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill(ruleName)

  // Pattern is required for a valid rule.
  const patInput = bob.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("test-pattern")

  await bob.getByRole("button", { name: /^Create rule$/ }).click()
  await expect(bob.getByText(ruleName)).toBeVisible({ timeout: 8_000 })

  // Bob clicks "Request promotion".
  const requestBtn = bob.getByRole("button", { name: /Request promotion/i }).first()
  await expect(requestBtn).toBeVisible({ timeout: 8_000 })
  await requestBtn.click()
  // Wait for "Requested" state to confirm request was submitted.
  await expect(bob.getByText(/Requested/i).first()).toBeVisible({ timeout: 8_000 })

  // Alice refreshes her rules view to pick up the pending request.
  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")
  await alice.reload()
  await alice.waitForLoadState("networkidle")

  // Alice should see "Pending promotion requests" section with a Dismiss button.
  const dismissBtn = alice.getByRole("button", { name: /^Dismiss$/i }).first()
  await expect(dismissBtn).toBeVisible({ timeout: 10_000 })
  await dismissBtn.click()

  // The dismiss button (and the pending request) should be gone.
  await expect(dismissBtn).not.toBeVisible({ timeout: 5_000 })
})
