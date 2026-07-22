// AQU-247 regression: a committed edit must stay visible even when a
// full-file cells refetch that STARTED before the commit resolves after it.
// The route shim below snapshots the stream response immediately (so its
// data genuinely predates the commit) but delivers it seconds later — the
// exact race that blanked the edited cell/row in the 2026-06-09 demo until
// a manual page refresh.
//
// The targeted single-cell refetch (`cellIds=`) is left untouched: it is the
// post-commit confirm path, and letting it run fast is precisely what used
// to clear the optimistic shadow before the stale swap clobbered the row.

import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

test("a commit made while a slow stale refetch is in flight never blanks or loses the cell", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Stale refetch ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Hold every FULL-file cells stream (side=…) behind an explicit release
  // gate. The response is snapshotted before the edit, then delivered exactly
  // when the test asks; targeted cellIds= fetches pass through untouched.
  let releaseStaleResponse!: () => void
  const staleResponseReleased = new Promise<void>((resolve) => {
    releaseStaleResponse = resolve
  })
  let staleTargetResponseCaptured = false
  const deliveredSides = new Set<string>()

  // Warm files normally revalidate through the cheap `?since=` delta path.
  // Force that request to take its documented resync fallback so this test
  // deterministically reaches the full-stream race it is meant to cover.
  await alice.route(/\/cells\?since=\d+(?:&.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ resync: true }),
    })
  })
  await alice.route(/\/cells\?(?=.*side=)(?!.*cellIds=).*/, async (route) => {
    const side = new URL(route.request().url()).searchParams.get("side")
    const response = await route.fetch()
    const body = await response.body()
    if (side === "target") staleTargetResponseCaptured = true
    await staleResponseReleased
    await route.fulfill({ response, body })
    if (side) deliveredSides.add(side)
  })

  // Kick a soft refetch (focus handler) so a stale stream is in flight…
  await alice.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => staleTargetResponseCaptured, {
    message: "target-side stale response should be captured before the edit",
    timeout: 10_000,
  }).toBe(true)

  // …then commit an edit while it is.
  const text = `Survives stale swap ${Date.now()}`
  await ws.editCell(0, text)

  // Deliver the stale target snapshot, then wait for BOTH sequential sides of
  // the full stream to finish. Waiting only for target let teardown reload the
  // page while the source route was still being fulfilled, which produced a
  // spurious "Route is already handled" failure and, more importantly, made
  // the assertion run before useCells performed its atomic buffer swap.
  releaseStaleResponse()
  await expect.poll(() => [...deliveredSides].sort(), {
    message: "both sides of the held full-file stream should be delivered",
    timeout: 10_000,
  }).toEqual(["source", "target"])
  await expect(ws.cellRow(0)).toContainText(text)

  // And survive a real reload (server projection has it).
  await alice.unroute(/\/cells\?since=\d+(?:&.*)?$/)
  await alice.unroute(/\/cells\?(?=.*side=)(?!.*cellIds=).*/)
  await alice.reload()
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 5_000 })
})
