/**
 * AQU-1679 — link an established project to a source project and have the
 * link replace the source of a file the project already has, keeping its
 * translations.
 *
 * Full-suite journey. It is here, and not only in the worker suites, because
 * the feature is one promise made across four layers: the confirm step asks
 * the identity worker how the two files compare, the link request records the
 * pair, the sync worker joins the files line by line on the first mirror sync,
 * and the editor then has to show ONE file whose translation is still on its
 * line. Each layer has its own tests; none of them can see a translation go
 * missing between two of the others. A team that picks this option and loses
 * its work has no way back.
 *
 * Flow:
 *   1. Upstream: a project with sample.md imported.
 *   2. Established: its own project, with the same sample.md imported on its
 *      own — so the two files share no cell id — and one line translated.
 *   3. Settings → Source & sync → link to the upstream, "Its Source". The
 *      confirm step flags the same-named file; turn on "Replace the source in
 *      my existing …", read that every line matches, confirm.
 *   4. The project still has exactly one file, its cells are the SAME cells,
 *      and the translation is still on its line.
 *   5. An upstream source edit reaches that same cell on the next sync.
 */

import { randomUUID } from "node:crypto"
import { test, expect } from "../../helpers/multi-user"
import { resetBackend } from "../../helpers/seed"
import {
  jwtFor,
  mintSyncToken,
  openSeededProject,
  readProjectedCells,
  seedProjectWithFile,
} from "../../helpers/seed-project"

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

// The backend reset rides on the `alice` fixture; a bob-only spec does its own.
test.beforeEach(async () => {
  await resetBackend()
})

async function projectFileNames(jwt: string, projectId: string): Promise<string[]> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!r.ok) throw new Error(`project read failed: HTTP ${r.status} — ${await r.text()}`)
  const body = (await r.json()) as { files?: Array<{ name: string }> }
  return (body.files ?? []).map((f) => f.name).sort()
}

test("replacing the source of a file the project already has keeps one file and its translations", async ({ bob }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("bob")
  const stamp = Date.now()

  const upstream = await seedProjectWithFile(jwt, { name: `LinkUpstream ${stamp}` })
  const established = await seedProjectWithFile(jwt, { name: `LinkEstablished ${stamp}` })
  // The premise: the same material imported twice shares no cell identity.
  expect(established.cellIds.some((id) => upstream.cellIds.includes(id))).toBe(false)

  // Translate one line of the established project's own file, in the editor.
  const ws = await openSeededProject(bob, established)
  const translation = `Tafsiri iliyopo ${stamp}`
  await ws.editCell(0, translation)
  await expect
    .poll(async () => (await readProjectedCells(jwt, established, "target")).map((c) => c.value))
    .toContain(translation)
  const sourceBefore = await readProjectedCells(jwt, established, "source")

  // Link from Settings → Source & sync.
  await bob.goto(`/project/${established.projectId}/settings/source-sync`)
  await bob.getByRole("combobox", { name: "Source project" }).click()
  await bob.getByRole("option", { name: upstream.projectName }).click()
  await bob.getByRole("radio", { name: /^Its Source/i }).click()
  await bob.getByRole("button", { name: "Review what will be added" }).click()

  // The confirm step flags the clash, and offers to replace instead.
  const replace = bob.getByRole("checkbox", { name: /^Replace the source in my existing/ })
  await expect(replace).toBeVisible({ timeout: 10_000 })
  await replace.click()
  const lines = upstream.cellIds.length
  await expect(
    bob.getByText(`${lines} of ${lines} lines are the same in both files.`),
  ).toBeVisible({ timeout: 10_000 })
  await expect(
    bob.getByText("1 file you already have will take its source from this link and keep its translations."),
  ).toBeVisible()

  const linked = bob.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(`/projects/${established.projectId}/link-source`),
  )
  await bob.getByRole("button", { name: "Link source project" }).click()
  expect((await linked).status()).toBe(200)

  // One file, the same cells, the translation still on its line.
  await expect.poll(() => projectFileNames(jwt, established.projectId)).toEqual([established.fileName])
  const sourceAfter = await readProjectedCells(jwt, established, "source")
  expect(sourceAfter.map((c) => [c.cellId, c.value])).toEqual(sourceBefore.map((c) => [c.cellId, c.value]))
  const targets = await readProjectedCells(jwt, established, "target")
  expect(targets.map((c) => c.value)).toContain(translation)

  // An upstream edit now reaches the established project's OWN cell.
  const upstreamSource = await readProjectedCells(jwt, upstream, "source")
  const edited = upstreamSource[1]
  const newText = `Upstream wording ${stamp}`
  const upstreamToken = await mintSyncToken(jwt, upstream.projectId, upstream.fileId)
  const emit = await fetch(`${SYNC_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstreamToken}` },
    body: JSON.stringify({
      events: [
        {
          id: randomUUID(),
          schemaVersion: 1,
          projectId: upstream.projectId,
          fileId: upstream.fileId,
          cellId: edited.cellId,
          parentId: edited.eventId,
          kind: "source.cell.commit",
          author: "bob",
          payload: { value: newText },
          clientTs: Date.now(),
        },
      ],
    }),
  })
  expect(emit.status, await emit.clone().text()).toBe(200)
  expect(((await emit.json()) as { rejected?: unknown[] }).rejected ?? []).toEqual([])

  const downstreamToken = await mintSyncToken(jwt, established.projectId, "__project__")
  await expect
    .poll(async () => {
      await fetch(`${SYNC_BASE}/api/v1/projects/${established.projectId}/link/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${downstreamToken}` },
      })
      const rows = await readProjectedCells(jwt, established, "source")
      return rows.find((c) => c.cellId === established.cellIds[1])?.value
    })
    .toBe(newText)
  // Still one file, and still no second line for that text.
  expect(await projectFileNames(jwt, established.projectId)).toEqual([established.fileName])
  const finalSource = await readProjectedCells(jwt, established, "source")
  expect(finalSource).toHaveLength(sourceBefore.length)
})
