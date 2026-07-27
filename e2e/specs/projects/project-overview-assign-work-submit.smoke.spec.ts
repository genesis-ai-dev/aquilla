import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, addProjectMember, getMyOrg, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ProjectOverview — Assign work form with seeded member.
 *
 * AssignWork.tsx (role="group" aria-label="Assign work") has Base UI selects
 * (combobox triggers):
 *   - aria-label="Assignee" (project members only — AQU-676)
 *   - aria-label="Book" (project files)
 *   - aria-label="Chapter" (optional, auto-populated)
 *
 * AQU-676: the assignee picker lists only the project's own members (direct
 * override / group / creator path). Org-baseline-only members must be absent
 * and unassignable.
 *
 * This spec: seed bob and carol in alice's org → create project + import
 * file → grant bob a direct project membership (carol stays org-only) →
 * open assign form → bob is listed, carol is not → select bob + a book →
 * verify the Assign button is enabled.
 */
test("assign work form lists project members only and enables Assign", async ({ alice }) => {
  // Seed bob and carol in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)
  await addOrgMember(aliceSession.jwt, acme.id, "carol", ROLE.CONTRIBUTOR)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AssignSubmit ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // AQU-676: bob gets a direct project grant so he is a project member;
  // carol keeps only her org-baseline access and must not be assignable.
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.CONTRIBUTOR)

  // Import a file so the Book select has options.
  await alice.goto(`/project/${projectId}/editor`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to the project overview.
  await alice.goto(`/projects/${projectId}`)
  // Open the Assign form.
  const assignBtn = alice.getByRole("button", { name: /^Assign…$/i })
  await expect(assignBtn).toBeVisible({ timeout: 10_000 })
  await assignBtn.click()

  const form = alice.locator('[role="group"][aria-label="Assign work"]')
  await expect(form).toBeVisible({ timeout: 5_000 })

  // Open the assignee picker. Bob (project member) appearing proves the
  // roster has loaded — only then is carol's absence meaningful (AQU-676).
  const assigneeSelect = form.getByRole("combobox", { name: "Assignee" })
  await expect(assigneeSelect).toBeVisible({ timeout: 3_000 })
  await assigneeSelect.click()
  const bobOption = alice.getByRole("option", { name: /bob/i })
  await expect(bobOption).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("option", { name: /carol/i })).toHaveCount(0)

  // Select bob as assignee.
  await bobOption.click()
  await expect(alice.getByRole("listbox")).toBeHidden({ timeout: 3_000 })

  // Select a book (first available file).
  const bookSelect = form.getByRole("combobox", { name: "Book" })
  await expect(bookSelect).toBeVisible({ timeout: 3_000 })
  await bookSelect.click()
  const firstBook = alice.getByRole("option").first()
  await expect(firstBook).toBeVisible({ timeout: 3_000 })
  await firstBook.click()
  await expect(alice.getByRole("listbox")).toBeHidden({ timeout: 3_000 })

  // The Assign button becomes enabled.
  const submitBtn = form.getByRole("button", { name: /^Assign$/i })
  await expect(submitBtn).toBeVisible({ timeout: 3_000 })
  await expect(submitBtn).toBeEnabled({ timeout: 3_000 })
})
