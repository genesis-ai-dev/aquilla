/**
 * waivers-mirror: Y.Doc cell.waivers (legacy plain JS array of RuleWaiver
 * stored as a Y.Map field) → local-store `waivers` rows. First edit-keyed
 * mirror — captures text_snapshot + cell_version_at at the moment the
 * waiver appears. See DATA_PERSISTENCE_PLAN.md §4.10–§4.11 and §9.2.
 */

import { beforeEach, describe, expect, test } from "vitest"
import * as Y from "yjs"
import { LocalStore } from "@/lib/local-store/db"
import { MIGRATIONS } from "@/lib/local-store/migrations"
import { listPending } from "@/lib/local-store/outbox"
import { upsertCell } from "@/lib/local-store/cells"
import {
  getActiveWaiversForCell,
  getWaiver,
} from "@/lib/local-store/waivers"
import type { CellRow } from "@/lib/local-store/cells"
import type { MirrorContext } from "./registry"
import { createWaiversMirror } from "./waivers-mirror"

const NOW = 1_700_000_000_000

interface LegacyWaiver {
  ruleId: string
  reason?: string
  waivedAt: string
  waivedBy?: string
}

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    id: "p1:c1",
    project_id: "p1",
    scope_id: "s",
    address: "c1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "src",
    source_text_hash: "h",
    source_version_id: "v",
    translation_text: "current target text",
    tag_dictionary: "{}",
    status: "draft",
    approved_at_version: null,
    locked_by_user_id: null,
    version: 5,
    last_edited_by: null,
    last_edited_at: null,
    seq: 1,
    created_at: 0,
    updated_at: 0,
    org_id: "org-1",
    source_lang: "eng",
    target_lang: "spa",
    format_meta: "{}",
    label: null,
    backtranslation_pinned_id: null,
    ...overrides,
  }
}

function ensureCell(yDoc: Y.Doc, cellId: string): Y.Map<unknown> {
  const cellsMap = yDoc.getMap("cells")
  let cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) {
    cell = new Y.Map()
    cellsMap.set(cellId, cell)
  }
  return cell
}

function setWaivers(
  yDoc: Y.Doc,
  cellId: string,
  waivers: LegacyWaiver[],
): void {
  yDoc.transact(() => {
    const cell = ensureCell(yDoc, cellId)
    cell.set("waivers", waivers)
  })
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
}

async function setup(): Promise<{
  yDoc: Y.Doc
  store: LocalStore
  ctx: MirrorContext
  cleanup: () => Promise<void>
}> {
  const store = await LocalStore.open({ name: ":memory:" })
  await store.migrate(MIGRATIONS)
  const yDoc = new Y.Doc()
  const ctx: MirrorContext = {
    store,
    actorId: "u-actor",
    now: () => NOW,
  }
  return {
    yDoc,
    store,
    ctx,
    cleanup: async () => {
      yDoc.destroy()
      await store.close()
    },
  }
}

describe("waivers mirror", () => {
  let yDoc: Y.Doc
  let store: LocalStore
  let ctx: MirrorContext
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ yDoc, store, ctx, cleanup } = await setup())
  })

  test("bootstrap captures text_snapshot + cell_version_at from the live cell", async () => {
    await upsertCell(store, makeCell({ version: 5, translation_text: "v5 text" }))
    setWaivers(yDoc, "p1:c1", [
      {
        ruleId: "no-honorifics",
        reason: "regional flavor",
        waivedAt: new Date(NOW).toISOString(),
        waivedBy: "u1",
      },
    ])

    const mirror = createWaiversMirror({ yDoc })
    await mirror.bootstrap(ctx)

    const rows = await getActiveWaiversForCell(store, "p1:c1")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      cell_id: "p1:c1",
      rule_id: "no-honorifics",
      cell_version_at: 5,
      text_snapshot: "v5 text",
      state: "approved",
      justification: "regional flavor",
      proposed_by: "u1",
    })

    await cleanup()
  })

  test("bootstrap is idempotent — same waiver replays without dup rows", async () => {
    await upsertCell(store, makeCell({ version: 5, translation_text: "t" }))
    setWaivers(yDoc, "p1:c1", [
      { ruleId: "r1", waivedAt: new Date(NOW).toISOString() },
    ])
    const mirror = createWaiversMirror({ yDoc })
    await mirror.bootstrap(ctx)
    await mirror.bootstrap(ctx)

    const rows = await getActiveWaiversForCell(store, "p1:c1")
    expect(rows).toHaveLength(1)

    await cleanup()
  })

  test("attach: a new waiver added later emits waiver.propose outbox", async () => {
    await upsertCell(store, makeCell({ version: 7, translation_text: "v7" }))
    const mirror = createWaiversMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)

    setWaivers(yDoc, "p1:c1", [
      {
        ruleId: "r-new",
        reason: "ok",
        waivedAt: new Date(NOW).toISOString(),
        waivedBy: "u1",
      },
    ])
    await flush()

    const rows = await getActiveWaiversForCell(store, "p1:c1")
    expect(rows).toHaveLength(1)
    expect(rows[0].cell_version_at).toBe(7)
    expect(rows[0].text_snapshot).toBe("v7")

    const pending = await listPending(store)
    const kinds = pending.map((p) => JSON.parse(p.payload).kind as string)
    expect(kinds).toContain("waiver.propose")

    dispose()
    await cleanup()
  })

  test("attach: a removed waiver transitions to revoked + emits waiver.transition", async () => {
    await upsertCell(store, makeCell({ version: 3, translation_text: "v3" }))
    setWaivers(yDoc, "p1:c1", [
      { ruleId: "r1", waivedAt: new Date(NOW).toISOString() },
    ])
    const mirror = createWaiversMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)

    setWaivers(yDoc, "p1:c1", []) // user removed the waiver
    await flush()

    const rowsActive = await getActiveWaiversForCell(store, "p1:c1")
    expect(rowsActive).toHaveLength(0)

    // The historical waiver row exists with state='revoked'.
    const all = await store.query<{ state: string }>(
      "SELECT state FROM waivers WHERE cell_id = ?",
      ["p1:c1"],
    )
    expect(all.map((r) => r.state)).toContain("revoked")

    const pending = await listPending(store)
    const kinds = pending.map((p) => JSON.parse(p.payload).kind as string)
    expect(kinds).toContain("waiver.transition")

    dispose()
    await cleanup()
  })

  test("dispose stops observation", async () => {
    await upsertCell(store, makeCell({ version: 1 }))
    const mirror = createWaiversMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)
    dispose()

    setWaivers(yDoc, "p1:c1", [
      { ruleId: "r1", waivedAt: new Date(NOW).toISOString() },
    ])
    await flush()

    expect(await getActiveWaiversForCell(store, "p1:c1")).toHaveLength(0)
    await cleanup()
  })

  test("waiver becomes naturally stale when cell version moves", async () => {
    // Initially version 3, waiver gets text_snapshot from v3.
    await upsertCell(store, makeCell({ version: 3, translation_text: "v3 text" }))
    setWaivers(yDoc, "p1:c1", [
      { ruleId: "r1", waivedAt: new Date(NOW).toISOString() },
    ])
    const mirror = createWaiversMirror({ yDoc })
    await mirror.bootstrap(ctx)

    // Cell version moves to 4 (someone edited the translation).
    await upsertCell(
      store,
      makeCell({ version: 4, translation_text: "v4 text" }),
    )

    // The historical waiver still exists with text_snapshot from v3.
    const w = await getWaiver(store, makeWaiverId("p1:c1", "r1"))
    expect(w?.cell_version_at).toBe(3)
    expect(w?.text_snapshot).toBe("v3 text")
    // Caller can compare cell.version (4) vs waiver.cell_version_at (3) and
    // render "waived at v3, current is v4" staleness.

    await cleanup()
  })
})

function makeWaiverId(cellId: string, ruleId: string): string {
  return `${cellId}::${ruleId}`
}
