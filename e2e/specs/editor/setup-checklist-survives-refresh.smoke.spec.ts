import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * AQU-694 — the setup checklist survives a browser refresh while the user is
 * mid-setup, WITHOUT ever becoming an auto-open.
 *
 * Mechanism: opening the drawer records a per-project "mid-setup" flag in
 * localStorage; the workspace restores the drawer on load only when that flag is
 * set. Dismissing (or completing) the checklist clears the flag.
 *
 * These specs cover the three load-time outcomes:
 *   1. Restore   — opened + refreshed → drawer comes back on its own.
 *   2. No auto-open — never opened + refreshed → drawer stays closed (chip only).
 *   3. Dismissal wins — opened, skipped, refreshed → drawer stays closed.
 */

test("AQU-694: checklist reopens after a refresh when the user was mid-setup", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ChecklistRefresh ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Open the checklist via the chip — this marks the project as mid-setup.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()
  const heading = alice.getByRole("heading", { name: /Project setup/i })
  await expect(heading).toBeVisible({ timeout: 5_000 })

  // Refresh the browser — the drawer must restore itself on load.
  await alice.reload()
  // The restored drawer is a modal sheet that aria-hides the background —
  // including the Setup chip — so the chip can never be a post-reload
  // readiness probe here: the faster the restore, the sooner it disappears
  // from the a11y tree. Wait directly on the outcome (drawer heading), with
  // the 30s cold-hydration watchdog since this follows a full page load.
  await expect(
    alice.getByRole("heading", { name: /Project setup/i })
  ).toBeVisible({ timeout: 30_000 })
})

test("AQU-694: no auto-open — a never-opened checklist stays closed after refresh", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ChecklistNoAuto ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The chip is present, but we never open the checklist.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })

  await alice.reload()
  // Workspace rehydrated (chip visible) — but the drawer must NOT auto-open.
  await expect(alice.getByRole("button", { name: /Setup:/i })).toBeVisible({ timeout: 30_000 })
  await expect(
    alice.getByRole("heading", { name: /Project setup/i })
  ).not.toBeVisible({ timeout: 5_000 })
})

test("AQU-694: dismissal wins — skipped checklist stays closed after refresh", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ChecklistDismiss ${Date.now()}` })
  await openSeededProject(alice, seeded)

  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()
  const heading = alice.getByRole("heading", { name: /Project setup/i })
  await expect(heading).toBeVisible({ timeout: 5_000 })

  // Skip for now → dismissal clears the mid-setup flag.
  const skipBtn = alice.getByRole("button", { name: /Skip for now/i })
  await expect(skipBtn).toBeVisible({ timeout: 3_000 })
  await skipBtn.click()
  await expect(heading).not.toBeVisible({ timeout: 5_000 })

  await alice.reload()
  // Workspace rehydrated (chip visible) — dismissed checklist must stay closed.
  await expect(alice.getByRole("button", { name: /Setup:/i })).toBeVisible({ timeout: 30_000 })
  await expect(
    alice.getByRole("heading", { name: /Project setup/i })
  ).not.toBeVisible({ timeout: 5_000 })
})
