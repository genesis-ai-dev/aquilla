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

  // Delay every FULL-file cells stream (side=…) by 4s — response is fetched
  // (snapshotted) immediately, delivered late. Targeted cellIds= fetches
  // pass through untouched.
  await alice.route(/\/cells\?(?=.*side=)(?!.*cellIds=).*/, async (route) => {
    const response = await route.fetch()
    const body = await response.body()
    await new Promise((r) => setTimeout(r, 4_000))
    await route.fulfill({ response, body })
  })

  // Kick a soft refetch (focus handler) so a stale stream is in flight…
  await alice.evaluate(() => window.dispatchEvent(new Event("focus")))
  await alice.waitForTimeout(300)

  // …then commit an edit while it is.
  const text = `Survives stale swap ${Date.now()}`
  await ws.editCell(0, text)

  // The edit must stay continuously visible through the stale stream's
  // delivery (+ swap). Poll past the 4s delay with margin.
  for (let i = 0; i < 7; i++) {
    await alice.waitForTimeout(1_000)
    await expect(ws.cellRow(0)).toContainText(text)
  }

  // And survive a real reload (server projection has it).
  await alice.unroute(/\/cells\?(?=.*side=)(?!.*cellIds=).*/)
  await alice.reload()
  await alice.waitForLoadState("networkidle")
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 5_000 })
})
