import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * AiModelsStep — "We don't use voice or transcription — skip this" (AQU-701).
 *
 * The skip is a device-local flag (IDB) layered onto a server-loaded project
 * record. Regression this guards: the skip write silently no-oped when the
 * project had no IDB row (the normal thin-client case, exactly what a seeded
 * e2e project reproduces), and the flag was dropped by the post-save refetch,
 * so the link appeared to do nothing.
 *
 * This spec: open the setup checklist → expand "Configure voice &
 * transcription" → click the skip link → the step reads complete (progress
 * count increments; the item auto-collapses by design) → re-expand → the
 * skipped confirmation shows → "Set up anyway" re-arms the step.
 */
test("setup checklist voice skip completes the step and is reversible", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `VoiceSkip ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Open the setup checklist.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  await expect(alice.getByRole("heading", { name: /Project setup/i })).toBeVisible({
    timeout: 5_000,
  })

  // Seeded baseline: only "Import files" is complete.
  const progress = alice.getByText(/of \d+ complete/i)
  await expect(progress).toHaveText("1 of 4 complete", { timeout: 10_000 })

  // Expand the "Configure voice & transcription" item.
  const voiceItem = alice.locator("button[aria-expanded]").filter({
    hasText: /Configure voice/i,
  })
  await expect(voiceItem).toBeVisible({ timeout: 5_000 })
  await voiceItem.click()
  await expect(voiceItem).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // Skip. The step flips complete once the refreshed record carries the flag,
  // and the checklist stops flagging it (progress increments). The item
  // auto-collapses on completion — that's ChecklistItem's designed behavior.
  await alice.getByRole("button", { name: /skip this/i }).click()
  await expect(progress).toHaveText("2 of 4 complete", { timeout: 10_000 })

  // Reversible: re-expand, confirm the skipped state, opt back in.
  await voiceItem.click()
  await expect(voiceItem).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })
  await expect(alice.getByText(/skipped for this project/i)).toBeVisible({ timeout: 5_000 })
  await alice.getByRole("button", { name: /Set up anyway/i }).click()

  // The step re-arms: the skip link returns and the count drops back.
  await expect(alice.getByRole("button", { name: /skip this/i })).toBeVisible({
    timeout: 10_000,
  })
  await expect(progress).toHaveText("1 of 4 complete", { timeout: 10_000 })
})
