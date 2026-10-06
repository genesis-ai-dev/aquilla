/**
 * Check pack B over a published translation (AQU-1699; design doc §10): the
 * `--pack-b` mode of scripts/bible-checks-eval.ts.
 *
 * Precision: P1, P3, P5, P6 per verse and the P2, X3 scans per book, with the
 * English names of the 30 NT entities the Greek names most often as
 * `render.*` decisions (the pack's English label, plus the other names an
 * English Bible uses for them: "Christ", "Cephas"). The profile says English
 * "you" has no number and "we" no clusivity, so P8 and P9 are dormant.
 *
 * Recall (mutations, seeded): Peter and John swapped in 50 verses that name
 * them (P5), a name dropped from 50 verses (P1), and, under a SYNTHETIC profile
 * with planted forms, "you" singular/plural swapped (P8) and inclusive/exclusive
 * "we" swapped (P9).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildNameTable, entityNameFactKey, isNameWord } from "../../db/shared/bible-checks/agreed-names"
import { compileFileExpectations } from "../../db/shared/bible-checks/compile"
import { evaluateCell, isBibleCheckDormant } from "../../db/shared/bible-checks/evaluate"
import type { PeopleLayerInput } from "../../db/shared/bible-checks/participant-types"
import { scanNameConsistency, scanRepeatedQuotations } from "../../db/shared/bible-checks/scans-pack-b"
import type {
  BibleCheckFinding,
  CellExpectation,
  StructureLayerInput,
  TextLayerInput,
  VoicesLayerInput,
} from "../../db/shared/bible-checks/types"
import type { LanguageProfile } from "../../db/shared/language-profile"
import type { ProjectFact } from "../../db/shared/project-facts"

export interface PackBEvalInput {
  packDir: string
  books: readonly string[]
  versesByBook: ReadonlyMap<string, { ref: string; text: string }[]>
  /** The English profile the pack-A run uses (quotation marks, question markers, negators, number words). */
  english: LanguageProfile
  samples: number
  seed: number
}

const PRECISION_CHECKS = ["bkp:P1", "bkp:P2", "bkp:P3", "bkp:P5", "bkp:P6", "bkp:X3"] as const
const MUTATIONS = 50

/** The other names an English Bible uses for these entities (WEB): what an English project would agree. */
const ENGLISH_ALIASES: Readonly<Record<string, string>> = {
  "person:Jesus.2": "Jesus|Christ|Messiah|Immanuel",
  "person:Peter": "Peter|Simon|Cephas",
  "group:Jews": "Jew",
  "person:Paul": "Paul|Saul",
  "place:Jerusalem": "Jerusalem|Zion|Salem",
  "person:Israel": "Israel|Jacob",
  "group:Pharisee": "Pharisee",
  "person:Pilate": "Pilate|Pontius",
  "deity:Satan": "Satan|Beelzebul|Belial",
  "person:Judas.2": "Judas|Iscariot",
  "place:Nazareth": "Nazareth|Nazarene",
  "person:Herod.2": "Herod",
  "person:Javan": "Greek",
  "place:Rome": "Rome|Roman",
}

function readLayer<T>(packDir: string, layer: string, book: string): T | null {
  const path = join(packDir, layer, `${book}.json`)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null
}

/** Deterministic, so a run can be repeated. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sample<T>(items: readonly T[], n: number, rand: () => number): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, n)
}

function fact(key: string, value: string): ProjectFact {
  return { id: key, key, value, scope: {}, author: "eval", at: "2026-10-06T00:00:00.000Z" }
}

/** The 30 ACAI entities the NT names most often, by proper-noun mentions. */
function topEntities(input: PackBEvalInput, n: number): { entity: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const book of input.books) {
    const people = readLayer<PeopleLayerInput>(input.packDir, "people", book)
    const text = readLayer<TextLayerInput>(input.packDir, "text", book)
    if (!people || !text) continue
    for (const [id, entity] of Object.entries(people.entities)) if (!labels.has(id)) labels.set(id, entity.labels.eng ?? id)
    for (const [wordId, mention] of Object.entries(people.mentions)) {
      if (mention.kind !== "explicit" || !/^(person|group|deity|place):/.test(mention.entity)) continue
      if (!isNameWord(text.words[wordId])) continue
      counts.set(mention.entity, (counts.get(mention.entity) ?? 0) + 1)
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([entity, count]) => ({ entity, label: labels.get(entity) ?? entity, count }))
}

interface BookRun {
  book: string
  verses: { ref: string; text: string }[]
  expectations: Map<string, CellExpectation>
  findings: Map<string, BibleCheckFinding[]>
}

const SYNTHETIC_YOU: LanguageProfile["pronouns"] = { secondPerson: { numberDistinction: true, singular: ["yu"], plural: ["yupela"] } }
const SYNTHETIC_WE: LanguageProfile["pronouns"] = {
  firstPersonPlural: { clusivity: true, inclusive: ["yumi"], exclusive: ["mipela"] },
}
const YOU = /\b(?:you|your|yours|yourself|yourselves)\b/giu
const WE = /\b(?:we|us|our|ours|ourselves)\b/giu

export function runPackBEval(input: PackBEvalInput): void {
  const rand = random(input.seed)
  const top = topEntities(input, 30)
  const facts = top.map(({ entity, label }) =>
    fact(entityNameFactKey(entity), ENGLISH_ALIASES[entity] ?? label.replace(/\s*\([^)]*\)\s*$/u, "")),
  )
  const profile: LanguageProfile = {
    ...input.english,
    pronouns: { secondPerson: { numberDistinction: false }, firstPersonPlural: { clusivity: false } },
  }
  console.log(`pack B: ${facts.length} render.* decisions: ${facts.map((f) => `${f.key}=${f.value}`).join("; ")}`)
  console.log(`pack B: P8 dormant=${isBibleCheckDormant("bkp:P8", profile)}, P9 dormant=${isBibleCheckDormant("bkp:P9", profile)}`)

  const counts = new Map<string, number>(PRECISION_CHECKS.map((id) => [id, 0]))
  const reasons = new Map<string, number>()
  const flagged = new Map<string, string[]>(PRECISION_CHECKS.map((id) => [id, []]))
  const runs: BookRun[] = []
  let total = 0
  const record = (code: string, reason: string, line: string) => {
    if (!counts.has(code)) return
    counts.set(code, (counts.get(code) ?? 0) + 1)
    reasons.set(`${code} ${reason}`, (reasons.get(`${code} ${reason}`) ?? 0) + 1)
    flagged.get(code)?.push(line)
  }
  const describe = (f: BibleCheckFinding) => Object.entries(f.params).filter(([k]) => k !== "nameFrom").map(([k, v]) => `${k}=${v}`).join(" ")

  for (const book of input.books) {
    const verses = input.versesByBook.get(book)
    const voices = readLayer<VoicesLayerInput>(input.packDir, "voices", book)
    const people = readLayer<PeopleLayerInput>(input.packDir, "people", book)
    if (!verses || !voices || !people) continue
    const structure = readLayer<StructureLayerInput>(input.packDir, "structure", book)
    const text = readLayer<TextLayerInput>(input.packDir, "text", book)
    const names = buildNameTable({ people, text, facts, sourceLanguage: "en" })
    const cells = verses.map(({ ref, text: t }) => ({ id: ref, globalReferences: [ref], text: t }))
    const expectations = compileFileExpectations(cells, voices, structure, text, { people, names })
    const findings = new Map<string, BibleCheckFinding[]>()
    for (const { ref, text: verseText } of verses) {
      const expectation = expectations.get(ref)
      if (!expectation) continue
      total++
      const found = evaluateCell(verseText, expectation, profile)
      findings.set(ref, found)
      for (const f of found) record(f.code, f.reason, `${ref} [${f.reason} ${describe(f)}] ${verseText}`)
    }
    for (const f of scanNameConsistency(cells, expectations)) {
      record(f.code, f.reason, `${f.cellId} [${f.reason} ${describe(f)}] ${verses.find((v) => v.ref === f.cellId)?.text ?? ""}`)
    }
    if (text) {
      for (const f of scanRepeatedQuotations(cells, voices, text, profile)) {
        record(f.code, f.reason, `${f.cellId} [${describe(f)}] ${verses.find((v) => v.ref === f.cellId)?.text ?? ""}`)
      }
    }
    runs.push({ book, verses, expectations, findings })
  }

  const rate = (n: number) => (total ? ((100 * n) / total).toFixed(2) : "0.00")
  console.log(`pack B: ${total} verses; flags per 100 verses: ${PRECISION_CHECKS.map((id) => `${id} ${rate(counts.get(id) ?? 0)}`).join(", ")}`)
  for (const [key, n] of [...reasons].sort()) console.log(`  ${key}: ${n} (${rate(n)} per 100 verses)`)
  for (const id of PRECISION_CHECKS) {
    const all = flagged.get(id) ?? []
    const step = all.length / Math.max(1, Math.min(input.samples, all.length))
    for (let i = 0; i < Math.min(input.samples, all.length); i++) console.log(`${id}  ${all[Math.floor(i * step)]}`)
  }

  mutationSwapPeterJohn(runs, profile, rand)
  mutationDropName(runs, profile, facts, rand)
  synthetic(runs, { ...profile, pronouns: SYNTHETIC_YOU }, "bkp:P8", rand)
  synthetic(runs, { ...profile, pronouns: SYNTHETIC_WE }, "bkp:P9", rand)
}

const newOf = (before: readonly BibleCheckFinding[], after: readonly BibleCheckFinding[], code: string) =>
  after.filter((f) => f.code === code && !before.some((b) => b.code === code && b.reason === f.reason && b.params.found === f.params.found && b.params.name === f.params.name))

function mutationSwapPeterJohn(runs: readonly BookRun[], profile: LanguageProfile, rand: () => number): void {
  const candidates: { run: BookRun; ref: string; text: string }[] = []
  for (const run of runs) {
    for (const { ref, text } of run.verses) {
      const named = run.expectations.get(ref)?.participants?.named.map((m) => m.entity) ?? []
      const namesThem = named.some((id) => id === "person:Peter" || id === "person:John" || id === "person:John.2")
      if (namesThem && /\b(?:Peter|John)\b/u.test(text)) candidates.push({ run, ref, text })
    }
  }
  let p5 = 0
  let any = 0
  // A verse that names both men still names both after the swap: no presence check can see it.
  let single = 0
  let singleP5 = 0
  const picked = sample(candidates, MUTATIONS, rand)
  for (const { run, ref, text } of picked) {
    const swapped = text.replace(/\b(Peter|John)\b/gu, (word) => (word === "Peter" ? "John" : "Peter"))
    const after = evaluateCell(swapped, run.expectations.get(ref), profile)
    const before = run.findings.get(ref) ?? []
    const named = new Set(run.expectations.get(ref)?.participants?.named.map((m) => (m.entity === "person:Peter" ? "Peter" : m.entity.startsWith("person:John") ? "John" : "")))
    const both = named.has("Peter") && named.has("John")
    const caughtP5 = newOf(before, after, "bkp:P5").length > 0
    if (caughtP5) p5++
    if (!both) {
      single++
      if (caughtP5) singleP5++
    }
    if (caughtP5 || ["bkp:P3", "bkp:P6", "bkp:P1"].some((code) => newOf(before, after, code).length > 0)) any++
    else console.log(`  missed swap${both ? " (names both)" : ""}: ${ref} ${swapped}`)
  }
  console.log(
    `mutation Peter↔John: ${picked.length} of ${candidates.length} verses; P5 caught ${p5} (${pct(p5, picked.length)}); ` +
      `P5, P6, P3 or P1 caught ${any} (${pct(any, picked.length)}); of the ${single} that name only one of them, P5 caught ${singleP5} (${pct(singleP5, single)})`,
  )
}

function mutationDropName(runs: readonly BookRun[], profile: LanguageProfile, facts: readonly ProjectFact[], rand: () => number): void {
  const renderingsOf = new Map(facts.map((f) => [f.key, f.value.split("|")]))
  const candidates: { run: BookRun; ref: string; text: string; drop: RegExp; entity: string }[] = []
  for (const run of runs) {
    for (const { ref, text } of run.verses) {
      for (const m of run.expectations.get(ref)?.participants?.named ?? []) {
        const renderings = renderingsOf.get(entityNameFactKey(m.entity))
        if (!renderings) continue
        const drop = new RegExp(`\\b(?:${renderings.join("|")})\\w{0,3}\\b`, "gu")
        if (drop.test(text)) {
          candidates.push({ run, ref, text, drop, entity: m.entity })
          break
        }
      }
    }
  }
  let caught = 0
  const picked = sample(candidates, MUTATIONS, rand)
  for (const { run, ref, text, drop, entity } of picked) {
    const dropped = text.replace(drop, "").replace(/\s{2,}/gu, " ")
    const after = evaluateCell(dropped, run.expectations.get(ref), profile)
    const before = run.findings.get(ref) ?? []
    if (newOf(before, after, "bkp:P1").length > 0) caught++
    else console.log(`  missed drop (${entity}): ${ref} ${dropped}`)
  }
  console.log(`mutation drop a name: ${picked.length} of ${candidates.length} verses; P1 caught ${caught} (${pct(caught, picked.length)})`)
}

/** Plant the synthetic forms the pack says are right, check them (false flags), then swap them (catches). */
function synthetic(runs: readonly BookRun[], profile: LanguageProfile, code: "bkp:P8" | "bkp:P9", rand: () => number): void {
  const planted: { run: BookRun; ref: string; right: string; wrong: string }[] = []
  const decided = { inclusive: 0, exclusive: 0, unknown: 0 }
  for (const run of runs) {
    for (const { ref, text } of run.verses) {
      const p = run.expectations.get(ref)?.participants
      if (!p) continue
      if (code === "bkp:P8") {
        const number = p.secondPerson?.number
        if ((number !== "singular" && number !== "plural") || !p.secondPerson?.explicit || !YOU.test(text)) continue
        YOU.lastIndex = 0
        const [right, wrong] = number === "singular" ? ["yu", "yupela"] : ["yupela", "yu"]
        planted.push({ run, ref, right: text.replace(YOU, right), wrong: text.replace(YOU, wrong) })
      } else {
        for (const m of p.firstPlural) decided[m.clusivity ?? "unknown"]++
        const values = new Set(p.firstPlural.map((m) => m.clusivity).filter((c) => c !== null))
        if (values.size !== 1 || !WE.test(text)) continue
        WE.lastIndex = 0
        const [right, wrong] = values.has("inclusive") ? ["yumi", "mipela"] : ["mipela", "yumi"]
        planted.push({ run, ref, right: text.replace(WE, right), wrong: text.replace(WE, wrong) })
      }
      YOU.lastIndex = 0
      WE.lastIndex = 0
    }
  }
  let falseFlags = 0
  for (const { run, ref, right } of planted) {
    if (evaluateCell(right, run.expectations.get(ref), profile).some((f) => f.code === code)) falseFlags++
  }
  let caught = 0
  const picked = sample(planted, MUTATIONS, rand)
  for (const { run, ref, wrong } of picked) {
    if (evaluateCell(wrong, run.expectations.get(ref), profile).some((f) => f.code === code && f.reason.endsWith("-wrong"))) caught++
  }
  if (code === "bkp:P9") console.log(`P9 data: first-person plurals decided inclusive ${decided.inclusive}, exclusive ${decided.exclusive}, unknown ${decided.unknown}`)
  console.log(
    `synthetic ${code}: ${planted.length} verses with planted forms; flags on the right forms ${falseFlags} (${pct(falseFlags, planted.length)}); ` +
      `swapped in ${picked.length}: caught ${caught} (${pct(caught, picked.length)})`,
  )
}

function pct(n: number, of: number): string {
  return of ? `${((100 * n) / of).toFixed(0)}%` : "n/a"
}
