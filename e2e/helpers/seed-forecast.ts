/**
 * Seed a TRANSLATED project for the BIA ghost-text / thesaurus journeys.
 *
 * Ghost text learns from a project's own validated target cells, so an empty
 * seeded project would show nothing. This imports Genesis 1 (World English
 * Bible) as USFM source through `seedProjectWithFile`, then writes the Reina-
 * Valera 1909 target for every verse except the held-out ones as ordinary
 * `target.cell.commit` + `cell.validate` events through `POST /events` — the
 * same write path the editor uses. Both texts are public domain.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { extractUsfmStrings } from "../../src/lib/parsers/usfm"
import { readProjectLanes, updateProjectSettings } from "./frontier-api"
import { mintSyncToken, seedProjectWithFile, type SeededProject } from "./seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, "../fixtures/forecast-genesis-1.json")
const SYNC_BASE = process.env.E2E_SYNC_BASE
  ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

interface ForecastFixture {
  sourceLanguage: string
  targetLanguage: string
  verses: Array<{ ref: string; source: string; target: string }>
}

export interface SeededTranslatedProject extends SeededProject {
  /** Editor row index of a verse ref, e.g. rowOf("GEN 1:25"). */
  rowOf: (ref: string) => number
}

/**
 * @param heldOut verse refs left untranslated (e.g. "GEN 1:25").
 */
export async function seedTranslatedProject(
  jwt: string,
  author: string,
  opts: { heldOut: string[]; name?: string },
): Promise<SeededTranslatedProject> {
  const fixture = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as ForecastFixture
  const usfm = [
    "\\id GEN", "\\h Genesis", "\\c 1", "\\p",
    ...fixture.verses.map((v) => `\\v ${v.ref.split(":")[1]} ${v.source}`),
  ].join("\n")
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aq-forecast-"))
  const usfmPath = path.join(dir, "Genesis 1.usfm")
  await fs.writeFile(usfmPath, `${usfm}\n`)
  const seeded = await seedProjectWithFile(jwt, { name: opts.name ?? `Genesis ${Date.now()}`, fixturePath: usfmPath })
  await fs.rm(dir, { recursive: true, force: true })

  // The importer may split a long verse across cells; the same parser over the
  // same text yields the same order, so read each cell's verse ref from it.
  const refs = extractUsfmStrings(usfm).flatMap((book) => book.strings).map((s) => s.context)
  if (refs.length !== seeded.cellIds.length) {
    throw new Error(`parsed ${refs.length} cells but seeded ${seeded.cellIds.length}`)
  }
  const rowOf = (ref: string) => {
    const row = refs.indexOf(ref)
    if (row < 0) throw new Error(`no cell for ${ref}`)
    return row
  }
  await updateProjectSettings(jwt, seeded.projectId, {
    sourceLanguage: fixture.sourceLanguage,
    targetLanguage: fixture.targetLanguage,
  })

  // The default target lane's row id: the projection keys cells by lane.
  const lanes = await readProjectLanes(jwt, seeded.projectId)
  const lane = lanes.find((l) => l.role === "target" && !l.archivedAt)
  if (!lane) throw new Error("seeded project has no target lane")
  const laneFields = { laneId: lane.id }

  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const base = { schemaVersion: 1, projectId: seeded.projectId, fileId: seeded.fileId, author }
  const events = fixture.verses.flatMap((verse) => {
    if (opts.heldOut.includes(verse.ref)) return []
    // A split verse's whole target goes on its first cell.
    const cellId = seeded.cellIds[rowOf(verse.ref)]
    const commitId = randomUUID()
    return [
      { ...base, id: commitId, cellId, parentId: null, kind: "target.cell.commit", payload: { value: verse.target, ...laneFields }, clientTs: Date.now() },
      { ...base, id: randomUUID(), cellId, parentId: null, kind: "cell.validate", payload: { editEventId: commitId, ...laneFields }, clientTs: Date.now() },
    ]
  })
  const response = await fetch(`${SYNC_BASE}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
  if (!response.ok) throw new Error(`seeding target events failed: HTTP ${response.status} — ${await response.text()}`)
  const body = (await response.json()) as { accepted?: unknown[]; rejected?: unknown[] }
  if ((body.rejected ?? []).length > 0 || (body.accepted ?? []).length !== events.length) {
    throw new Error(`seeding target events was not fully accepted: ${JSON.stringify(body).slice(0, 500)}`)
  }
  return { ...seeded, rowOf }
}
