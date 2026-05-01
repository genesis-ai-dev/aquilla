import { test, expect } from "../../helpers/multi-user"

// NOTE: Selectors here are based on the planned UI shape. They may need
// tightening during Task 26 end-to-end verification — orgs surfaces are
// less stable than projects/editor.
test("alice (Acme owner) adds bob to her org and bob sees Acme on his dashboard", async ({ alice, bob }) => {
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
