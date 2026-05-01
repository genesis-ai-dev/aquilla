import { test, expect } from "../../helpers/multi-user"

// FIXME: Selectors here are speculative. The flow assumes a button labelled
// /Acme/i opens an org switcher, then a /members/i link inside it. The actual
// app routes /members at the top level (MembersPage) and uses useOrg() context
// to scope, not a per-org button. Spec needs to be rewritten against the real
// org-management UI once we identify the right entrypoint.
test.fixme("alice (Acme owner) adds bob to her org and bob sees Acme on his dashboard", async ({ alice, bob }) => {
  // alice navigates to her org members page.
  // Acme is pre-seeded by /__test__/reset with alice as owner.
  await alice.goto("/")
  await alice.getByRole("button", { name: /Acme/i }).first().click()
  await alice.getByRole("link", { name: /members/i }).click()
  await alice.getByRole("button", { name: /add member|invite/i }).click()
  await alice.getByLabel(/username/i).fill("bob")
  await alice.getByRole("button", { name: /add|invite|confirm/i }).click()
  await expect(alice.getByText("bob")).toBeVisible({ timeout: 5_000 })

  // bob reloads — Acme should now appear in his org switcher
  await bob.goto("/")
  await bob.reload()
  await expect(bob.getByText(/Acme/i)).toBeVisible({ timeout: 10_000 })
})
