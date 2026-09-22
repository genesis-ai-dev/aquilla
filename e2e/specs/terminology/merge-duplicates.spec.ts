import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { addProjectMember } from "../../helpers/frontier-api"
import {
  jwtFor,
  openSeededProject,
  readProjectedConcepts,
  seedProjectWithFile,
} from "../../helpers/seed-project"

/**
 * AQU-1337 — merge duplicate concepts from the live Glossary surface.
 *
 * Merge is the only termbase action that REMOVES concepts for good, and it is
 * two writes, not one: a `term.update` carrying the survivor's union-merged
 * renderings, then a `term.delete` per merged-away concept. The journey this
 * protects crosses SPA → outbox → sync-worker (`term.*` events) → Postgres
 * projection and back:
 *
 *   1. Two concepts with the SAME source term — what importing a termbase
 *      twice produces — merge into the first one picked.
 *   2. The result is server state, not the merger's optimistic state: a second
 *      project member sees one concept holding both renderings — in the
 *      projection read and on their own Glossary — and so does the merger
 *      after a reload.
 *
 * The dialog's own rules (two-pick minimum, survivor = first pick, preview,
 * failure handling) and the role gate are RTL — `TerminologyMergeDialog.test.tsx`
 * and `GlossaryEditor.test.tsx`.
 */

const TERM = "grace"

test("merged duplicates collapse into the survivor for every member and survive a reload", async ({ alice, bob }) => {
  const aliceJwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(aliceJwt, { name: `Merge ${Date.now()}` })
  await addProjectMember(aliceJwt, seeded.projectId, "bob")
  await openSeededProject(alice, seeded)

  const glossary = new Glossary(alice)
  await glossary.goto(seeded.projectId)
  await glossary.addTerm(TERM, "favor")
  await glossary.addTerm(TERM, "mercy")
  await glossary.addTerm("wrath", "anger")
  await expect(glossary.row(TERM)).toHaveCount(2)

  await glossary.mergeConcepts("favor", "mercy")

  // Authoritative, and as ANOTHER member: both writes landed — the survivor
  // holds the union and the merged-away concept is tombstoned out of the read.
  const bobJwt = await jwtFor("bob")
  await expect
    .poll(async () => {
      const concepts = await readProjectedConcepts(bobJwt, seeded.projectId)
      return concepts
        .map((c) => `${c.sourceTerm}: ${c.renderings.map((r) => r.rendering).join(", ")}`)
        .sort()
    })
    .toEqual([`${TERM}: favor, mercy`, "wrath: anger"])

  // Bob's glossary hydrates from that read: one row, carrying both renderings.
  const bobGlossary = new Glossary(bob)
  await bobGlossary.goto(seeded.projectId)
  await expect(bobGlossary.row(TERM)).toHaveCount(1)
  await expect(bobGlossary.row(TERM)).toContainText("favor")

  // …and the merger's own surface agrees once it re-hydrates from the server.
  await alice.reload()
  await glossary.goto(seeded.projectId)
  await expect(glossary.row(TERM)).toHaveCount(1)
  const survivor = await glossary.expandTerm(TERM)
  await expect(survivor.getByRole("textbox", { name: "Rendering 1 text" })).toHaveValue("favor")
  await expect(survivor.getByRole("textbox", { name: "Rendering 2 text" })).toHaveValue("mercy")
  await expect(glossary.row("wrath")).toHaveCount(1)
})
