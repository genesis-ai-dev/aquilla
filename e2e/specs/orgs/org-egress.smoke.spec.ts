import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { readFile } from "node:fs/promises"
import JSZip from "jszip"

/**
 * Org Data egress smoke — an org admin exports everything as one zip.
 *
 * What this covers:
 *  - The "Data egress" link renders in the OrgSidebar admin block for an org
 *    owner and routes to /orgs/:orgId/egress with the page heading.
 *  - The file inventory table lists the seeded file; the quick filter empties
 *    the table on a non-matching needle and restores rows when cleared.
 *  - Selection defaults to every file ("Export 1 file"); the "Select all
 *    files" header checkbox clears the selection ("Export 0 files", disabled)
 *    and restores it.
 *  - Export builds the zip client-side and downloadBlob() hands Playwright a
 *    download named <org>-egress-<yyyymmdd>.zip containing manifest.json plus
 *    the seeded markdown file's round-trip entry under the project folder.
 *
 * What this does NOT cover:
 *  - Audio modes, source-document sidecars, lane multi-select, and the export
 *    cache (vitest suites under src/lib/egress/ and src/lib/export/).
 *  - Role gating below maintainer (vitest: OrgDataEgress gate test).
 */
test("org admin exports all org data as one zip from Data egress", async ({ alice }) => {
  // Server-side seed: one project with sample.md lands in alice's personal
  // org, where she is OWNER — above the maintainer floor gating the surface.
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `Egress ${Date.now()}`,
  })

  await alice.goto(orgRoute(alice, ""))

  // Sidebar admin block → Data egress page.
  const egressLink = alice.getByRole("link", { name: "Data egress" })
  await expect(egressLink).toBeVisible({ timeout: 10_000 })
  await egressLink.click()
  await alice.waitForURL(/\/orgs\/\d+\/egress/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { level: 1, name: "Data egress" })).toBeVisible({
    timeout: 10_000,
  })

  // The org-wide inventory lists the seeded file as a row.
  const table = alice.getByTestId("egress-file-table")
  const seededRow = table.getByRole("row").filter({ hasText: seeded.fileName })
  await expect(seededRow).toBeVisible({ timeout: 10_000 })

  // Quick filter: a non-matching needle empties the table (the seeded project
  // is the org's only file, so zero rows is the deterministic outcome)…
  const filter = alice.getByPlaceholder("Filter files…")
  await filter.fill("no-such-file-zzz")
  await expect(seededRow).toHaveCount(0)
  await expect(table.getByText("No results.")).toBeVisible()
  // …and clearing it restores the row.
  await filter.fill("")
  await expect(seededRow).toBeVisible()

  // Selection defaults to all files once data loads; the header checkbox
  // clears and restores it. The Export button label is the observable
  // selection count.
  const exportOne = alice.getByRole("button", { name: "Export 1 file" })
  await expect(exportOne).toBeVisible()
  const selectAll = table.getByRole("checkbox", { name: "Select all files" })
  await selectAll.click()
  const exportZero = alice.getByRole("button", { name: "Export 0 files" })
  await expect(exportZero).toBeVisible()
  await expect(exportZero).toBeDisabled()
  await selectAll.click()
  await expect(exportOne).toBeVisible()

  // Export runs the client-side engine, then downloadBlob() fires an anchor
  // click that Playwright intercepts as a "download" event.
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }),
    exportOne.click(),
  ])
  expect(download.suggestedFilename()).toMatch(/-egress-\d{8}\.zip$/)

  const downloadedPath = await download.path()
  expect(downloadedPath).not.toBeNull()
  const archive = await JSZip.loadAsync(await readFile(downloadedPath!))
  const entryNames = Object.keys(archive.files)
  expect(entryNames).toContain("manifest.json")
  // Default text mode is round-trip, so the markdown seed comes back as a .md
  // under the project folder. Slugging/dedupe may decorate the path — match
  // on the base name, not an exact path.
  const fileBase = seeded.fileName.replace(/\.[^.]+$/, "")
  expect(
    entryNames.filter((name) => new RegExp(`${fileBase}[^/]*\\.md$`, "i").test(name)),
    `zip entries: ${entryNames.join(", ")}`,
  ).not.toHaveLength(0)
})
