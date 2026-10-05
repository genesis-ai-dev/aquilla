// @vitest-environment node
// AQU-1573: the reference Bible store against real Postgres (PGlite), through
// the production shim, with the migration as written.
import { PGlite } from "@electric-sql/pglite"
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { extractUsfmVerses } from "../../src/lib/reference-bible/usfm-verses"
import type { ReferenceVerseRow } from "../../src/lib/reference-bible/types"
import { PostgresDb, type AquillaDb, type PgExecutor } from "../shim/postgres"
import {
  getReferenceBible,
  listReferenceBibles,
  loadReferencePassagesForSources,
  lookupPassages,
  validateReferenceBibleSetting,
} from "./reference-bible"
import { isReferenceBibleCurrent, loadReferenceBibleVersion, type ReferenceBibleManifestEntry } from "./reference-bible-load"

const root = path.resolve(import.meta.dirname, "../..")
const fixture = (name: string) =>
  extractUsfmVerses(readFileSync(path.join(root, "src/lib/reference-bible/__fixtures__", name), "utf8"))

const pg = new PGlite()
function executor(db: PGlite): PgExecutor {
  const wrap = (q: { query: PGlite["query"] }): PgExecutor => ({
    async run(sql, params) {
      const r = await q.query<Record<string, unknown>>(sql, params as unknown[])
      return { rows: r.rows, rowCount: (r as { affectedRows?: number }).affectedRows ?? r.rows.length }
    },
    begin: (fn) => db.transaction((tx) => fn(wrap(tx as unknown as PGlite))) as Promise<never>,
  })
  return wrap(db)
}
const db: AquillaDb = new PostgresDb(executor(pg))

function entry(id: string, verses: readonly ReferenceVerseRow[], over: Partial<ReferenceBibleManifestEntry> = {}): ReferenceBibleManifestEntry {
  return {
    id,
    name: id === "arb-vandyck" ? "Van Dyck" : "King James Version",
    fullName: id,
    languageCode: id.startsWith("arb") ? "ar" : "en",
    languageName: id.startsWith("arb") ? "Arabic" : "English",
    direction: id.startsWith("arb") ? "rtl" : "ltr",
    versification: "eng",
    printing: null,
    license: "Public domain",
    source: { provider: "eBible.org", ebibleId: id, url: "https://example.invalid", buildDate: "2026-10-02", zipSha256: "z" },
    verseCount: verses.length,
    contentSha256: `sha-${verses.length}-${verses[0]?.text.length ?? 0}`,
    file: `${id}.tsv.gz`,
    ...over,
  }
}

const arbRows = fixture("arb-vd-sample.usfm")
const kjvRows = fixture("eng-kjv-sample.usfm")

beforeAll(async () => {
  await pg.exec(readFileSync(path.join(root, "db/postgres/migrations/0131_reference_bibles.sql"), "utf8"))
}, 30_000)
afterAll(async () => {
  await pg.close()
})
beforeEach(async () => {
  await pg.exec("TRUNCATE reference_bible_verses, reference_bible_versions")
})

const count = async (id: string) =>
  Number((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM reference_bible_verses WHERE version_id = $1", [id])).rows[0].n)

describe("loadReferenceBibleVersion (AQU-1573)", () => {
  it("loads once, then skips by hash and only refreshes metadata", async () => {
    expect(await loadReferenceBibleVersion(db, entry("arb-vandyck", arbRows), arbRows)).toBe("loaded")
    expect(await count("arb-vandyck")).toBe(144)
    expect(await isReferenceBibleCurrent(db, entry("arb-vandyck", arbRows))).toBe(true)
    const renamed = entry("arb-vandyck", arbRows, { name: "Van Dyck (renamed)" })
    expect(await loadReferenceBibleVersion(db, renamed, arbRows)).toBe("already loaded")
    expect((await getReferenceBible(db, "arb-vandyck"))?.name).toBe("Van Dyck (renamed)")
  })

  it("replaces the verses when the content changes, and on force", async () => {
    await loadReferenceBibleVersion(db, entry("eng-kjv", kjvRows), kjvRows)
    const fewer = kjvRows.filter((r) => r.book === "JHN")
    expect(await loadReferenceBibleVersion(db, entry("eng-kjv", fewer), fewer)).toBe("loaded")
    expect(await count("eng-kjv")).toBe(fewer.length)
    expect(await loadReferenceBibleVersion(db, entry("eng-kjv", fewer), fewer, { force: true })).toBe("loaded")
    expect((await getReferenceBible(db, "eng-kjv"))?.verseCount).toBe(fewer.length)
  })

  it("leaves the previous text in place when a load fails part way", async () => {
    await loadReferenceBibleVersion(db, entry("eng-kjv", kjvRows), kjvRows)
    const broken = [...kjvRows.slice(0, 600), { book: "GEN", chapter: 0, verse: 1, text: "bad" }]
    await expect(loadReferenceBibleVersion(db, entry("eng-kjv", broken), broken)).rejects.toThrow()
    expect(await count("eng-kjv")).toBe(144)
    expect((await getReferenceBible(db, "eng-kjv"))?.verseCount).toBe(144)
  })

  it("refuses a verse count that disagrees with the manifest", async () => {
    await expect(loadReferenceBibleVersion(db, entry("eng-kjv", kjvRows, { verseCount: 3 }), kjvRows)).rejects.toThrow(/manifest/)
  })
})

describe("listing (AQU-1573)", () => {
  it("lists installed built-in Bibles only", async () => {
    await loadReferenceBibleVersion(db, entry("arb-vandyck", arbRows), arbRows)
    await loadReferenceBibleVersion(db, entry("eng-kjv", kjvRows), kjvRows)
    await pg.exec(`INSERT INTO reference_bible_versions (id, name, full_name, language_code, language_name, license, source, verse_count)
                   VALUES ('empty', 'E', 'E', 'fr', 'French', 'PD', 's', 0)`)
    await pg.exec(`INSERT INTO reference_bible_versions (id, name, full_name, language_code, language_name, license, source, verse_count, org_id)
                   VALUES ('partner', 'P', 'P', 'ar', 'Arabic', 'licensed', 's', 10, 42)`)
    const list = await listReferenceBibles(db)
    expect(list.map((v) => v.id)).toEqual(["arb-vandyck", "eng-kjv"])
    expect(list[0]).toMatchObject({ languageCode: "ar", direction: "rtl", verseCount: 144, source: "eBible.org arb-vandyck (build 2026-10-02)" })
    expect(await getReferenceBible(db, "empty")).toBeNull()
    expect(await getReferenceBible(db, "partner")).toBeNull()
  })
})

describe("lookupPassages (AQU-1573)", () => {
  beforeEach(async () => {
    await loadReferenceBibleVersion(db, entry("arb-vandyck", arbRows), arbRows)
  })

  it("returns verses for single verses and ranges, once per reference", async () => {
    const { passages, unresolved } = await lookupPassages(db, "arb-vandyck", ["ISA 40:25", "JHN 3:16-17", "ISA 40:25"])
    expect(unresolved).toEqual([])
    expect(passages.map((p) => [p.canonical, p.label, p.verses.map((v) => v.verse)])).toEqual([
      ["ISA 40:25", "Isaiah 40:25", [25]],
      ["JHN 3:16-17", "John 3:16–17", [16, 17]],
    ])
    expect(passages[0].verses[0].text).toMatch(/^«فَبِمَنْ/)
  })

  it("lists missing and malformed references as unresolved", async () => {
    const { passages, unresolved } = await lookupPassages(db, "arb-vandyck", ["ISA 40:99", "GEN 1:1", "nonsense", "ISA 40:31-35"])
    expect(unresolved).toEqual(["nonsense", "ISA 40:99", "GEN 1:1"])
    expect(passages.map((p) => p.verses.map((v) => v.verse))).toEqual([[31]])
  })

  it("follows a range across chapters and caps a passage at 30 verses", async () => {
    const rows: ReferenceVerseRow[] = []
    for (let v = 1; v <= 40; v++) rows.push({ book: "GEN", chapter: 1, verse: v, text: `1:${v}` })
    for (let v = 1; v <= 3; v++) rows.push({ book: "GEN", chapter: 2, verse: v, text: `2:${v}` })
    await loadReferenceBibleVersion(db, entry("test-gen", rows), rows)
    const { passages } = await lookupPassages(db, "test-gen", ["GEN 1:39-2:2", "GEN 1:1-40"])
    expect(passages[0].verses.map((v) => `${v.chapter}:${v.verse}`)).toEqual(["1:39", "1:40", "2:1", "2:2"])
    expect(passages[0].truncated).toBeUndefined()
    expect(passages[1].verses).toHaveLength(30)
    expect(passages[1].truncated).toBe(true)
  })
})

describe("loadReferencePassagesForSources (AQU-1573)", () => {
  beforeEach(async () => {
    await loadReferenceBibleVersion(db, entry("arb-vandyck", arbRows), arbRows)
  })
  const settings = { targetLanguage: "Arabic", referenceBibleVersions: { "": "arb-vandyck", en: "eng-kjv" } }

  it("returns null for a lane with no Bible", async () => {
    expect(await loadReferencePassagesForSources(db, { settings: { targetLanguage: "Arabic" }, lane: "", sources: ["Isaiah 40:25"] })).toBeNull()
    expect(await loadReferencePassagesForSources(db, { settings, lane: "fr", sources: ["Isaiah 40:25"] })).toBeNull()
  })

  it("names a chosen Bible that is not installed", async () => {
    expect(await loadReferencePassagesForSources(db, { settings, lane: "en", sources: ["Isaiah 40:25"] })).toEqual({
      version: null,
      passages: [],
      unresolved: [],
      missingVersionId: "eng-kjv",
    })
  })

  it("looks up the union of every source's references", async () => {
    const result = await loadReferencePassagesForSources(db, {
      settings,
      lane: "",
      sources: ["Isaiah 40:25 says…", "Read Romans 8 this week.", "(John 3:16) and again Isaiah 40:25", "Isaiah 40:99"],
    })
    expect(result?.version?.id).toBe("arb-vandyck")
    expect(result?.passages.map((p) => p.canonical)).toEqual(["ISA 40:25", "JHN 3:16"])
    expect(result?.unresolved).toEqual(["ISA 40:99"])
    expect(await loadReferencePassagesForSources(db, { settings, lane: "", sources: ["No references."] })).toMatchObject({ passages: [], unresolved: [] })
  })

  it("marks a range the finder cut to 30 verses as truncated (review 2026-10-02)", async () => {
    const result = await loadReferencePassagesForSources(db, { settings, lane: "", sources: ["Read Isaiah 40:1-31 tonight.", "Isaiah 40:25"] })
    expect(result?.passages.map((p) => [p.canonical, p.verses.length, p.truncated ?? false])).toEqual([
      ["ISA 40:1-30", 30, true],
      ["ISA 40:25", 1, false],
    ])
  })
})

describe("validateReferenceBibleSetting (AQU-1573)", () => {
  beforeEach(async () => {
    await loadReferenceBibleVersion(db, entry("arb-vandyck", arbRows), arbRows)
    await loadReferenceBibleVersion(db, entry("eng-kjv", kjvRows), kjvRows)
  })
  const merged = { targetLanguage: "Arabic", targetLanes: ["Arabic", "en"] }

  it("accepts the map, the one-item array, aliases for the default lane, {} and null", async () => {
    for (const v of [{ "": "arb-vandyck", en: "eng-kjv" }, ["arb-vandyck"], { Arabic: "arb-vandyck" }, { EN: "eng-kjv" }, {}, null]) {
      expect(await validateReferenceBibleSetting(db, v, merged)).toEqual({ ok: true })
    }
  })

  it("rejects an unknown Bible, naming what is installed", async () => {
    const r = await validateReferenceBibleSetting(db, ["nope"], merged)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/unknown Bible "nope".*arb-vandyck, eng-kjv.*list_reference_bibles/)
  })

  it("rejects a lane the project does not have, naming its lanes", async () => {
    const r = await validateReferenceBibleSetting(db, { fr: "arb-vandyck" }, merged)
    expect(!r.ok && r.message).toMatch(/"fr" is not a lane of this project\. Lanes: "" \(Arabic\), "en"/)
  })

  it("rejects two keys for the same lane and bad shapes", async () => {
    const twice = await validateReferenceBibleSetting(db, { "": "arb-vandyck", Arabic: "eng-kjv" }, merged)
    expect(!twice.ok && twice.message).toMatch(/same lane/)
    const two = await validateReferenceBibleSetting(db, ["arb-vandyck", "eng-kjv"], merged)
    expect(!two.ok && two.message).toMatch(/one Bible per lane/)
    const junk = await validateReferenceBibleSetting(db, "arb-vandyck", merged)
    expect(junk.ok).toBe(false)
  })
})
