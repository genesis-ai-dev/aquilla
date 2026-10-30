// Events replay gate: every corpus project replays through the production
// rebuild to exactly the projection rows the committed golden pins.
//
// Why this exists (docs/RELEASE-RISK-GATES.md): a PR that touches the events
// path is held off the hourly release line until a person signs it off. This
// suite is what lets a green PR skip that person. A failure here is not a
// flake and not a fixture to update by reflex: it says the candidate build
// projects a real-shaped event log to different rows than production does.
// If that is the point of the PR, regenerate the golden
// (UPDATE_REPLAY_GOLDEN=1 pnpm test replay-corpus) and let the golden diff
// be reviewed; the gate workflow keeps the hold on while golden.json changes.
//
// Corpus sources: `synthetic` entries are committed; `r2` entries are
// fetched by `node scripts/replay-corpus.mjs fetch`. A missing r2 corpus
// skips its case (loudly) unless REPLAY_CORPUS_REQUIRED=1, which the gate
// workflow sets so a fetch failure can never pass as green.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  CORPUS_DIR,
  OUTPUT_TABLES,
  corpusPath,
  diffDigest,
  loadCorpus,
  readGolden,
  readManifest,
  replayCorpus,
  type Golden,
} from "./helpers/replay-corpus"

const UPDATE = process.env.UPDATE_REPLAY_GOLDEN === "1"
const REQUIRED = process.env.REPLAY_CORPUS_REQUIRED === "1"
const REPLAY_TIMEOUT_MS = 10 * 60 * 1000

const manifest = readManifest()
const golden: Golden = readGolden()
const updated: Golden = { ...golden }

describe("replay corpus gate", () => {
  it("has at least one corpus project, so the gate can never pass vacuously", () => {
    expect(manifest.format).toBe(1)
    expect(manifest.projects.length).toBeGreaterThan(0)
  })

  it("digests every table the projection can write (ProjectionTouches + progress)", () => {
    // The union is a type, so read it off the source: a new projection
    // target added to event-projection.ts without a matching OUTPUT_TABLES
    // entry would leave the gate blind to that table.
    const source = readFileSync(path.resolve(CORPUS_DIR, "../src/events/event-projection.ts"), "utf8")
    const union = /export type ProjectionTouches = ([^\n]+)/.exec(source)?.[1] ?? ""
    const touched = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(touched.length).toBeGreaterThan(0)
    for (const table of touched) expect(OUTPUT_TABLES).toContain(table)
    expect(OUTPUT_TABLES).toContain("file_section_progress")
  })

  for (const entry of manifest.projects) {
    const present = existsSync(corpusPath(entry))
    if (!present && !REQUIRED) {
      it.skip(`${entry.slug}: corpus not fetched (run: node scripts/replay-corpus.mjs fetch)`, () => {})
      continue
    }
    it(
      `${entry.slug} (${entry.events} events) replays to the golden projection`,
      async () => {
        expect(present, `${entry.file} missing under ${CORPUS_DIR}; the gate requires every corpus`).toBe(true)
        const corpus = loadCorpus(entry)
        const result = await replayCorpus(entry.projectId, corpus)
        expect(result.rebuild.eventsRead).toBe(entry.events)
        if (entry.source === "synthetic") {
          // The synthetic log's sibling race is decided by chain_claims, not
          // seq order (AQU-1844): a replay that ignored the claims would still
          // hash consistently, so pin the rule itself, not only the hash.
          expect(result.tables.cells).toContain("gagnant, révisé")
          expect(result.tables.cells).not.toContain("perdant")
        }
        if (UPDATE) {
          updated[entry.slug] = result.digest
          return
        }
        const diff = diffDigest(golden[entry.slug], result.digest)
        if (diff.length) {
          const outDir = path.join(CORPUS_DIR, "out")
          mkdirSync(outDir, { recursive: true })
          for (const [table, rows] of Object.entries(result.tables)) {
            writeFileSync(path.join(outDir, `${entry.slug}.${table}.jsonl`), rows)
          }
          throw new Error(
            `${entry.slug}: projection differs from golden.json\n  ${diff.join("\n  ")}\n` +
              `Candidate rows written to ${outDir}/${entry.slug}.<table>.jsonl. ` +
              "If the change is intended, run UPDATE_REPLAY_GOLDEN=1 and have the golden diff reviewed.",
          )
        }
      },
      REPLAY_TIMEOUT_MS,
    )
  }

  if (UPDATE) {
    it("writes golden.json", () => {
      const ordered: Golden = {}
      for (const slug of Object.keys(updated).sort()) ordered[slug] = updated[slug]
      writeFileSync(path.join(CORPUS_DIR, "golden.json"), `${JSON.stringify(ordered, null, 2)}\n`)
    })
  }
})
