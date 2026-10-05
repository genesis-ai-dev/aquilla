// @vitest-environment node
// AQU-1573: the committed reference Bible text is complete, clean and matches
// its manifest, and `load` puts it into Postgres idempotently. No network.
import { PGlite } from "@electric-sql/pglite"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PostgresDb, type PgExecutor } from "../db/shim/postgres"
import { describeOutcomes, loadAll, readManifest, readVerses } from "./reference-bibles"

describe("committed reference Bibles (AQU-1573)", () => {
  const manifest = readManifest()

  it("ships Van Dyck Arabic and the KJV with eBible provenance", () => {
    expect(manifest.map((e) => [e.id, e.source.ebibleId, e.languageCode, e.direction])).toEqual([
      ["arb-vandyck", "arb-vd", "ar", "rtl"],
      ["eng-kjv", "eng-kjv2006", "en", "ltr"],
    ])
    for (const e of manifest) {
      expect(e.versification).toBe("eng")
      expect(e.license).toBe("Public domain")
      expect(e.source.zipSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  for (const entry of readManifest()) {
    describe(entry.id, () => {
      // readVerses checks the content hash against the manifest itself.
      const rows = readVerses(entry)
      const text = new Map(rows.map((r) => [`${r.book} ${r.chapter}:${r.verse}`, r.text]))

      it("matches the manifest's verse count with one row per verse", () => {
        expect(rows).toHaveLength(entry.verseCount)
        expect(text.size).toBe(entry.verseCount)
      })

      it("holds the verses the sermons cite, in English verse numbering", () => {
        for (const ref of ["ISA 40:25", "JHN 3:16", "ROM 8:28", "PSA 23:1", "1CO 13:4", "MAL 4:6", "REV 22:21"]) {
          expect(text.get(ref), ref).toBeTruthy()
        }
        expect(new Set(rows.map((r) => r.book)).size).toBe(66)
      })

      it("contains no USFM markup, pilcrows, tabs or stray whitespace", () => {
        for (const r of rows) {
          expect(r.text).not.toMatch(/[\\¶|\t]|strong=/)
          expect(r.text).toBe(r.text.trim())
          expect(r.chapter).toBeGreaterThan(0)
          expect(r.verse).toBeGreaterThan(0)
        }
      })
    })
  }

  it("keeps the vowelled Van Dyck and the plain 1769 KJV wording", () => {
    const [arb, kjv] = manifest.map((e) => new Map(readVerses(e).map((r) => [`${r.book} ${r.chapter}:${r.verse}`, r.text])))
    expect(arb.get("ISA 40:25")?.normalize("NFC")).toBe("«فَبِمَنْ تُشَبِّهُونَنِي فَأُسَاوِيَهُ؟» يَقُولُ ٱلْقُدُّوسُ.".normalize("NFC"))
    expect(kjv.get("ISA 40:25")).toBe("To whom then will ye liken me, or shall I be equal? saith the Holy One.")
    // Psalm titles are not verse 1.
    expect(kjv.get("PSA 3:1")).toMatch(/^LORD, how are they increased/)
    // The two verses Van Dyck numbers differently from the KJV (documented, not mapped).
    expect(arb.has("1TI 6:22") && arb.has("3JN 1:15")).toBe(true)
    expect(kjv.has("1TI 6:22") || kjv.has("3JN 1:15")).toBe(false)
  })
})

describe("reference-bibles load (AQU-1573)", () => {
  it("loads both Bibles, then finds them already loaded", async () => {
    const pg = new PGlite()
    const executor: PgExecutor = (() => {
      const wrap = (q: { query: PGlite["query"] }): PgExecutor => ({
        async run(sql, params) {
          const r = await q.query<Record<string, unknown>>(sql, params as unknown[])
          return { rows: r.rows, rowCount: (r as { affectedRows?: number }).affectedRows ?? r.rows.length }
        },
        begin: (fn) => pg.transaction((tx) => fn(wrap(tx as unknown as PGlite))) as Promise<never>,
      })
      return wrap(pg)
    })()
    try {
      await pg.exec(readFileSync(path.resolve(import.meta.dirname, "../db/postgres/migrations/0131_reference_bibles.sql"), "utf8"))
      const db = new PostgresDb(executor)
      const first = await loadAll(db)
      expect(describeOutcomes(first)).toBe("reference Bibles: arb-vandyck loaded (31104), eng-kjv loaded (31102)")
      const again = await loadAll(db)
      expect(describeOutcomes(again)).toBe("reference Bibles: arb-vandyck already loaded (31104), eng-kjv already loaded (31102)")
      expect((await loadAll(db, { only: "eng-kjv", ifMissing: true }))[0].status).toBe("already loaded")
      const n = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM reference_bible_verses")
      expect(n.rows[0].n).toBe(31104 + 31102)
    } finally {
      await pg.close()
    }
  }, 120_000)
})
