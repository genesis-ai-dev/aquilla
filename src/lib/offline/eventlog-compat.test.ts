// Unsent edits can cross an app update, so every build must replay each frozen fixture. Never edit one.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, Schema, type Store } from "@livestore/livestore"
import { describe, expect, it } from "vitest"
import { buildSampleSession } from "./__fixtures__/eventlog-sample"
import { OFFLINE_DATA_GENERATION, schema, tables } from "./schema"
import { STORE_ID } from "./store"

const FIXTURE_DIR = path.join(__dirname, "__fixtures__")
const FIXTURE_RE = /^eventlog-gen(\d+)\.json$/

interface EncodedEvent {
  name: string
  args: unknown
}

interface LocalSnapshot {
  queue: { id: string; status: string; cellId: string | null; payload: unknown }[]
  counts: Record<string, number>
}

interface EventlogFixture {
  generation: number
  storageFormatVersion: number
  storeId: string
  /** Printed payload type of every event this generation declared. */
  eventShapes: Record<string, string>
  events: EncodedEvent[]
  expected: LocalSnapshot
}

type CommitInput = Parameters<Store<typeof schema>["commit"]>[0]

let storeSeq = 0
async function makeStore(): Promise<Store<typeof schema>> {
  storeSeq += 1
  return createStorePromise({
    schema,
    storeId: `eventlog-compat-${storeSeq}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
}

function currentEventShapes(): Record<string, string> {
  return Object.fromEntries([...schema.eventsDefsMap].map(([name, def]) => [name, String(def.schema.ast)]).sort())
}

function snapshot(store: Store<typeof schema>): LocalSnapshot {
  const queue = store
    .query(tables.eventQueue.select())
    .map(({ id, status, cellId, payload }) => ({ id, status, cellId, payload }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const counts = {
    projects: store.query(tables.projects.select()).length,
    files: store.query(tables.files.select()).length,
    cells: store.query(tables.cells.select()).length,
    offlineProjects: store.query(tables.offlineProjects.select()).length,
    syncCursors: store.query(tables.syncCursors.select()).length,
  }
  return { queue, counts }
}

/** Mimics LiveStore's state rebuild. */
async function replay(encoded: EncodedEvent[]): Promise<Store<typeof schema>> {
  const store = await makeStore()
  for (const { name, args } of encoded) {
    const def = schema.eventsDefsMap.get(name)
    if (!def) throw new Error(`${name} is no longer declared — keep old events declared so existing eventlogs replay`)
    const decoded = Schema.decodeUnknownSync(def.schema)(args)
    store.commit({ name, args: decoded } as CommitInput)
  }
  return store
}

async function liveStoreStorageFormatVersion(): Promise<number> {
  // Not a direct dependency; resolve it via @livestore/livestore.
  const fromLivestore = createRequire(createRequire(import.meta.url).resolve("@livestore/livestore"))
  const common = (await import(fromLivestore.resolve("@livestore/common"))) as { liveStoreStorageFormatVersion: number }
  return common.liveStoreStorageFormatVersion
}

async function writeCurrentFixture(file: string): Promise<void> {
  const encoded = buildSampleSession().map(({ name, args }) => {
    const def = schema.eventsDefsMap.get(name)
    if (!def) throw new Error(`sample uses undeclared event ${name}`)
    return { name, args: Schema.encodeSync(def.schema)(args) }
  })
  const fixture: EventlogFixture = {
    generation: OFFLINE_DATA_GENERATION,
    storageFormatVersion: await liveStoreStorageFormatVersion(),
    storeId: STORE_ID,
    eventShapes: currentEventShapes(),
    events: encoded,
    expected: snapshot(await replay(encoded)),
  }
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
}

const currentFixtureFile = path.join(FIXTURE_DIR, `eventlog-gen${OFFLINE_DATA_GENERATION}.json`)
if (import.meta.env.VITE_UPDATE_OFFLINE_EVENTLOG_FIXTURE === "1" && !existsSync(currentFixtureFile)) {
  await writeCurrentFixture(currentFixtureFile)
}

const fixtures: EventlogFixture[] = readdirSync(FIXTURE_DIR)
  .filter((file) => FIXTURE_RE.test(file))
  .map((file) => JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")) as EventlogFixture)
  .sort((a, b) => a.generation - b.generation)
const newest = fixtures.at(-1)

describe.each(fixtures.map((f) => [f.generation, f] as const))("a generation %i eventlog", (_generation, fixture) => {
  it("replays on this build with its unsent edits intact", async () => {
    const store = await replay(fixture.events)
    const replayed = snapshot(store)
    expect(replayed.queue).toEqual(fixture.expected.queue)
    expect(replayed.counts).toEqual(fixture.expected.counts)
  })
})

describe("offline data compatibility tripwires", () => {
  it("has a frozen eventlog for the current generation", () => {
    expect(
      newest?.generation,
      `No eventlog fixture for OFFLINE_DATA_GENERATION ${OFFLINE_DATA_GENERATION} — run \`pnpm offline:fixture\``,
    ).toBe(OFFLINE_DATA_GENERATION)
  })

  it("declares the same events, with the same shapes, as the current generation's fixture", () => {
    expect(
      currentEventShapes(),
      "The offline events changed — bump OFFLINE_DATA_GENERATION in schema.ts and run `pnpm offline:fixture`",
    ).toEqual(newest?.eventShapes)
  })

  it("records every declared event in the sample session", () => {
    const sampled = new Set<string>(buildSampleSession().map((event) => event.name))
    const missing = [...schema.eventsDefsMap.keys()].filter((name) => !sampled.has(name))
    expect(missing, "Add these events to __fixtures__/eventlog-sample.ts").toEqual([])
  })

  it("keeps the store's OPFS location", async () => {
    // Both name the OPFS dir (`livestore-<storeId>@<format>`); changing either strands all data.
    expect(STORE_ID).toBe(newest?.storeId)
    expect(await liveStoreStorageFormatVersion()).toBe(newest?.storageFormatVersion)
  })
})
