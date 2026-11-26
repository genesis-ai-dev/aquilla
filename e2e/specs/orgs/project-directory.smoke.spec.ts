import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { createOrg, createProjectServerSide } from "../../helpers/frontier-api"

test("project rows stay usable while totals are pending or unavailable", async ({ alice }) => {
  const { jwt } = await ensureAuthState("alice")
  const org = await createOrg(jwt, "Directory timing")
  const project = await createProjectServerSide(jwt, {
    id: "directory-timing-project",
    name: "Directory timing project",
    orgId: org.id,
  })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await alice.route("**/api/v2/orgs/portfolio/summary", async route => {
    await pending
    await route.fulfill({ status: 503, json: { error: "Totals unavailable" } })
  })
  try {
    await alice.goto("/orgs/all")
    const row = alice.locator(`tr[data-project-id="${project.id}"]`)
    await expect(row).toBeVisible()
    release()
    await expect(alice.getByRole("alert").first()).toBeVisible()
    await expect(row).toBeVisible()
  } finally {
    release()
  }
})
