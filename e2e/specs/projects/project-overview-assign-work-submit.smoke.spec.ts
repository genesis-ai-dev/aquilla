import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ProjectOverview — Assign work form with seeded member.
 *
 * AssignWork.tsx (role="group" aria-label="Assign work") has Base UI selects
 * (combobox triggers):
 *   - aria-label="Assignee" (org members)
 *   - aria-label="Book" (project files)
 *   - aria-label="Chapter" (optional, auto-populated)
 *
 * With a seeded member in the org and a file imported, the Assign button
 * becomes enabled when an assignee and book are selected.
 *
 * This spec: seed bob in alice's org → create project + import file →
 * open assign form → select "bob" as assignee → select a book →
 * verify the Assign button is enabled.
 */
test("assign work form with seeded member enables Assign button", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AssignSubmit ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Import a file so the Book select has options.
  await alice.goto(`/project/${projectId}`)
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

  // Select bob as assignee.
  const assigneeSelect = form.getByRole("combobox", { name: "Assignee" })
  await expect(assigneeSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, assigneeSelect, /bob/i)

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
