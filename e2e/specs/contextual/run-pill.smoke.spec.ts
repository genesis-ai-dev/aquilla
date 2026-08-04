import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Contextual drafting run: enable the experimental flag, press play on the
 * floating pill, and watch the autonomous run drive the seeded file to
 * "Watching for changes" (parked) with staged drafts + scene briefs persisted.
 *
 * The pipeline's LLM calls happen SERVER-SIDE (auth-worker tick → mock
 * OpenRouter via OPENROUTER_BASE_URL, routed by the [[ctx:*]] prompt
 * markers), so no per-device provider override is needed. The flag is
 * device-local by design — the spec toggles it through the real settings UI.
 */
test("contextual run pill drives a seeded file to parked with staged drafts", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Contextual ${Date.now()}` })

  // Enable the device-local flag through the Experimental settings section
  // (the settings surface renders one section at a time via its side nav).
  await alice.goto(`/project/${seeded.projectId}/settings`)
  await alice.getByRole("link", { name: /Experimental/ }).click()
  const flagSwitch = alice.getByRole("switch", { name: "Contextual drafting" })
  await expect(flagSwitch).toBeVisible()
  await flagSwitch.click()
  await expect(flagSwitch).toBeChecked()

  // The pill is visible while its server capability snapshot is still
  // hydrating. Wait for that authoritative response before pressing Play so
  // the test does not race the intentional "backend unavailable" setup path.
  const contextualSnapshotLoaded = alice.waitForResponse((r) =>
    r.request().method() === "GET" &&
    r.url().includes("/contextual/runs?") &&
    r.status() === 200,
  )
  const ws = await openSeededProject(alice, seeded)
  await ws.waitForEditor()
  await contextualSnapshotLoaded

  // Idle pill: play affordance visible inside the editor viewport.
  const pill = alice.getByTestId("contextual-run-pill")
  await expect(pill).toBeVisible()
  const play = alice.getByRole("button", { name: "Contextual draft" })
  await expect(play).toBeVisible()

  const runCreated = alice.waitForResponse((r) =>
    r.request().method() === "POST" && r.url().includes("/contextual/runs") && r.status() === 201,
  )
  await play.click()
  await runCreated

  // The run works span by span server-side; the pill mirrors DO frames.
  // Cold multi-service pipeline (tick loop + mock LLM round-trips per span):
  // justified 30s readiness watchdog, waiting on observable pill state.
  await expect(pill).toContainText(/Watching for changes/, { timeout: 30_000 })

  // Cross-boundary: the run persisted its work product — proposed drafts and
  // at least one scene brief — reachable through the real API as the same user.
  const authBase = process.env.VITE_AUTH_BASE ?? ""
  expect(authBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
  const drafts = await alice.request.get(
    `${authBase}/api/v2/projects/${seeded.projectId}/contextual/drafts?fileId=${seeded.fileId}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  expect(drafts.ok()).toBe(true)
  const draftRows = (await drafts.json()) as { drafts: unknown[] }
  expect(draftRows.drafts.length).toBeGreaterThan(0)

  const briefs = await alice.request.get(
    `${authBase}/api/v2/projects/${seeded.projectId}/scene-briefs?fileId=${seeded.fileId}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  expect(briefs.ok()).toBe(true)
  const briefRows = (await briefs.json()) as { sceneBriefs: unknown[] }
  expect(briefRows.sceneBriefs.length).toBeGreaterThan(0)

  // Steering: direct the parked run through the pill's popover. The direction
  // is queued for the next passage — it must land server-side (2xx) and show
  // as a chip. (Steering a parked run also wakes it server-side; the chip is
  // asserted immediately after the POST, before the woken run can consume it.)
  await alice.getByRole("button", { name: "Direct the run" }).click()
  const steeringPopover = alice.getByTestId("contextual-steering-popover")
  await expect(steeringPopover).toBeVisible()
  await steeringPopover
    .getByLabel("Direction for the agent")
    .fill("Keep the tone formal in dialogue")
  const steeringPosted = alice.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes("/contextual/steering") &&
      r.status() >= 200 &&
      r.status() < 300,
  )
  await steeringPopover.getByRole("button", { name: "Send" }).click()
  await steeringPosted
  await expect(steeringPopover.getByTestId("contextual-steering-chip")).toContainText(
    "Keep the tone formal in dialogue",
  )
})
