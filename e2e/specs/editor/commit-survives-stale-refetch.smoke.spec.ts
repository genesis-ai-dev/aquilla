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
  let staleResponseCaptured = false
  let staleResponseDelivered = false

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
    const response = await route.fetch()
    const body = await response.body()
    staleResponseCaptured = true
    await staleResponseReleased
    await route.fulfill({ response, body })
    staleResponseDelivered = true
  })

  // Kick a soft refetch (focus handler) so a stale stream is in flight…
  await alice.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => staleResponseCaptured, {
    message: "full-file stale response should be captured before the edit",
    timeout: 10_000,
  }).toBe(true)

  // …then commit an edit while it is.
  const text = `Survives stale swap ${Date.now()}`
  await ws.editCell(0, text)

  // Deliver the stale snapshot and assert it cannot replace the newer edit.
  releaseStaleResponse()
  await expect.poll(() => staleResponseDelivered, {
    message: "held stale response should be delivered",
    timeout: 10_000,
  }).toBe(true)
  await expect(ws.cellRow(0)).toContainText(text)

  // And survive a real reload (server projection has it).
  await alice.unroute(/\/cells\?since=\d+(?:&.*)?$/)
  await alice.unroute(/\/cells\?(?=.*side=)(?!.*cellIds=).*/)
  await alice.reload()
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 5_000 })
})
