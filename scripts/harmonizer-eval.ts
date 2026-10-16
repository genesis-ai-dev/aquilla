// Harmonizer eval (AQU-1675): does each check find the error it exists for,
// and does it stay quiet on clean text?
//
// A published translation, paired with its source by verse reference, is a
// passage where every check SHOULD stay quiet. For each check, the eval damages
// one verse in the middle of a 9-verse window the way that check expects
// (src/lib/harmonizer/perturb.ts) and asks live Jev about both passages:
//
//   recall        the damaged passage gets the expected finding at that verse
//   false alarms  findings on the UNDAMAGED passage (the published text is
//                 assumed clean, so every one is a false alarm or a real
//                 disagreement worth reading)
//
// Swept over thresholds without re-asking: Jev answers are cached on disk by
// request hash, and findings are recomputed from the cache per threshold.
// Production code paths only: planHarmonizer + harmonizerFindings.
//
// Usage:
//   set -a; . auth-worker/.dev.vars; set +a
//   pnpm harmonizer:eval --vref <vref.txt> --target <one-verse-per-line.txt> \
//     --source <vref<TAB>text .tsv> [--books MAT,MRK,LUK,JHN,ACT] [--n 40] \
//     [--seed 1] [--cache .harmonizer-eval-cache] [--out harmonizer-eval]
//
// Default corpus layout is the eBible one (vref.txt + a line-aligned
// translation) with a vref-keyed source TSV (e.g. Macula Greek). Key:
// OPENROUTER_API_KEY or TYPESAFE_API_KEY; endpoint override JEV_DECISIONS_URL.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { JEV_DECISIONS_URL, JEV_MODEL } from "../src/lib/completion/seam-request"
import { CHECKS, harmonizerFindings, planHarmonizer, UNREGISTERED_CHECKS } from "../src/lib/harmonizer/runner"
import { PERTURBATIONS, type Perturbation, type PerturbationKind } from "../src/lib/harmonizer/perturb"
import type { HarmonizerCell, HarmonizerFinding } from "../src/lib/harmonizer/types"

/** Every check is asked and scored, so an unregistered one keeps being
 *  measured; only REGISTERED checks count toward the production alarm rate. */
const ALL_CHECKS = [...CHECKS, ...UNREGISTERED_CHECKS]
const REGISTERED = new Set(CHECKS.map((c) => c.id))

const WINDOW = 9
const CENTRE = 4
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9]

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : fallback
  if (v === undefined) throw new Error(`--${name} is required`)
  return v
}

/** Mulberry32 — a seeded sample is a reproducible sample. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function loadCorpus(books: Set<string>): Map<string, HarmonizerCell[]> {
  const refs = readFileSync(arg("vref"), "utf8").split("\n")
  const targets = readFileSync(arg("target"), "utf8").split("\n")
  const source = new Map<string, string>()
  for (const line of readFileSync(arg("source"), "utf8").split("\n")) {
    const tab = line.indexOf("\t")
    if (tab > 0) source.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim())
  }
  const byBook = new Map<string, HarmonizerCell[]>()
  refs.forEach((ref, i) => {
    const r = ref.trim()
    const book = r.split(" ")[0]
    if (!books.has(book)) return
    const target = (targets[i] ?? "").trim()
    const src = source.get(r) ?? ""
    if (!target || !src) return
    const list = byBook.get(book) ?? []
    list.push({ id: r, ref: r, source: src, target })
    byBook.set(book, list)
  })
  return byBook
}

const key = () => process.env.OPENROUTER_API_KEY || process.env.TYPESAFE_API_KEY

async function askJev(request: unknown, cacheDir: string): Promise<unknown> {
  const body = JSON.stringify(request)
  const file = join(cacheDir, `${createHash("sha256").update(body).digest("hex")}.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
  const k = key()
  if (!k) throw new Error("Live Jev needs OPENROUTER_API_KEY or TYPESAFE_API_KEY")
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(process.env.JEV_DECISIONS_URL?.trim() || JEV_DECISIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) {
      const json = await res.json()
      writeFileSync(file, JSON.stringify(json))
      return json
    }
    if (res.status < 500 && res.status !== 429) throw new Error(`Jev ${res.status}: ${await res.text()}`)
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
  }
  throw new Error("Jev failed after 3 attempts")
}

interface Case {
  perturbation: Perturbation
  clean: HarmonizerCell[]
}

interface Scored {
  case: Case
  damagedBody: unknown
  cleanBody: unknown
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

async function main(): Promise<void> {
  const books = new Set(arg("books", "MAT,MRK,LUK,JHN,ACT").split(","))
  const n = Number(arg("n", "40"))
  const random = rng(Number(arg("seed", "1")))
  const cacheDir = arg("cache", ".harmonizer-eval-cache")
  const outBase = arg("out", "harmonizer-eval")
  mkdirSync(cacheDir, { recursive: true })

  const corpus = loadCorpus(books)
  const cases = new Map<PerturbationKind, Case[]>()
  const eligible = new Map<PerturbationKind, number>()
  for (const [kind, perturb] of Object.entries(PERTURBATIONS) as [PerturbationKind, typeof PERTURBATIONS[PerturbationKind]][]) {
    const all: Case[] = []
    for (const verses of corpus.values()) {
      for (let i = CENTRE; i + (WINDOW - CENTRE) <= verses.length; i++) {
        const clean = verses.slice(i - CENTRE, i - CENTRE + WINDOW)
        const p = perturb(clean, CENTRE)
        if (p) all.push({ perturbation: p, clean })
      }
    }
    eligible.set(kind, all.length)
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[all[i], all[j]] = [all[j], all[i]]
    }
    cases.set(kind, all.slice(0, n))
  }

  const flat = [...cases.values()].flat()
  let done = 0
  const scored: Scored[] = await pool(flat, 4, async (c) => {
    const damagedRun = planHarmonizer(c.perturbation.cells, JEV_MODEL, ALL_CHECKS)
    const cleanRun = planHarmonizer(c.clean, JEV_MODEL, ALL_CHECKS)
    const damagedBody = damagedRun.request ? await askJev(damagedRun.request, cacheDir) : null
    const cleanBody = cleanRun.request ? await askJev(cleanRun.request, cacheDir) : null
    done++
    if (done % 10 === 0) process.stderr.write(`  ${done}/${flat.length}\n`)
    return { case: c, damagedBody, cleanBody }
  })

  const findingsAt = (cells: HarmonizerCell[], body: unknown, t: number): HarmonizerFinding[] =>
    body ? harmonizerFindings(planHarmonizer(cells, JEV_MODEL, ALL_CHECKS), cells, body, { minProbability: t }) : []

  type Row = { kind: PerturbationKind; threshold: number; cases: number; hits: number; recall: number; cleanAlarmsByCheck: Record<string, number>; cleanAlarmRate: number }
  const rows: Row[] = []
  const examples: Record<string, unknown[]> = {}
  const cleanAlarmExamples: unknown[] = []

  // The reference check's whole signal is Jev's "would a reader identify the
  // subject" answer. Damage that a reader can still resolve from dialogue turns
  // and content is not an error, so recall alone undersells or oversells it;
  // the shift in that answer between the original and the damaged verse is the
  // honest measure of whether the question discriminates at all.
  const clearAt = (cells: HarmonizerCell[], body: unknown, b: number): { switch?: number; clear?: number } => {
    const run = planHarmonizer(cells, JEV_MODEL, ALL_CHECKS)
    const answers = (body as { answers?: Record<string, { noul?: number }> } | null)?.answers ?? {}
    for (const { check, plan, prefix } of run.plans) {
      if (check.id !== "textual.reference") continue
      const i = (plan as { boundaries: { b: number }[] }).boundaries.findIndex((x) => x.b === b)
      if (i < 0) return {}
      return { switch: answers[`${prefix}r${i}_switch`]?.noul, clear: answers[`${prefix}r${i}_clear`]?.noul }
    }
    return {}
  }
  const refSignal = scored
    .filter((s) => s.case.perturbation.kind === "reference_switch")
    .map((s) => ({ damaged: clearAt(s.case.perturbation.cells, s.damagedBody, CENTRE), clean: clearAt(s.case.clean, s.cleanBody, CENTRE) }))
  const mean = (xs: (number | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === "number")
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN
  }
  const referenceSignal = {
    meanClearClean: mean(refSignal.map((r) => r.clean.clear)),
    meanClearDamaged: mean(refSignal.map((r) => r.damaged.clear)),
    meanSwitch: mean(refSignal.map((r) => r.damaged.switch)),
    damagedClearBelow: Object.fromEntries([0.5, 0.6, 0.7].map((t) => [t, refSignal.filter((r) => (r.damaged.clear ?? 1) < t).length])),
    cleanClearBelow: Object.fromEntries([0.5, 0.6, 0.7].map((t) => [t, refSignal.filter((r) => (r.clean.clear ?? 1) < t).length])),
  }
  for (const [kind, list] of cases) {
    const mine = scored.filter((s) => s.case.perturbation.kind === kind)
    for (const t of THRESHOLDS) {
      let hits = 0
      const alarms: Record<string, number> = {}
      for (const s of mine) {
        const p = s.case.perturbation
        const found = findingsAt(p.cells, s.damagedBody, t)
        const hit = found.some((f) => f.checkId === p.expectCheck && f.cellId === p.cells[p.expectCell].id)
        if (hit) hits++
        for (const f of findingsAt(s.case.clean, s.cleanBody, t)) {
          alarms[f.checkId] = (alarms[f.checkId] ?? 0) + 1
          if (t === 0.7 && cleanAlarmExamples.length < 25) {
            const c = s.case.clean.find((x) => x.id === f.cellId)
            cleanAlarmExamples.push({ check: f.checkId, ref: f.cellId, old: f.old, new: f.new, reason: f.reasonKey, target: c?.target })
          }
        }
        if (t === 0.7) {
          const ex = (examples[kind] ??= [])
          if (ex.length < 12) ex.push({ ref: p.cells[p.expectCell].ref, hit, note: p.note, damaged: p.cells[p.expectCell].target, found: found.map((f) => ({ check: f.checkId, cell: f.cellId, old: f.old, new: f.new, reason: f.reasonKey })) })
        }
      }
      const alarmTotal = Object.entries(alarms).filter(([k]) => REGISTERED.has(k)).reduce((a, [, b]) => a + b, 0)
      rows.push({ kind, threshold: t, cases: list.length, hits, recall: list.length ? hits / list.length : 0, cleanAlarmsByCheck: alarms, cleanAlarmRate: list.length ? alarmTotal / list.length : 0 })
    }
  }

  const result = { model: JEV_MODEL, window: WINDOW, books: [...books], eligible: Object.fromEntries(eligible), rows, referenceSignal, examples, cleanAlarmExamples }
  writeFileSync(`${outBase}.json`, JSON.stringify(result, null, 2))
  const md = [
    `# Harmonizer eval — ${JEV_MODEL}`,
    "",
    `Books: ${[...books].join(", ")} · window ${WINDOW} · eligible: ${[...eligible].map(([k, v]) => `${k} ${v}`).join(", ")}`,
    "",
    "| perturbation | threshold | cases | recall | clean alarms / passage (registered) | alarms by check |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.kind} | ${r.threshold} | ${r.cases} | ${(r.recall * 100).toFixed(0)}% | ${r.cleanAlarmRate.toFixed(2)} | ${Object.entries(r.cleanAlarmsByCheck).map(([k, v]) => `${k}${REGISTERED.has(k) ? "" : " (off)"} ${v}`).join(", ") || "—"} |`),
    "",
    `Reference signal (${refSignal.length} cases): mean "clear" original ${referenceSignal.meanClearClean.toFixed(2)} → damaged ${referenceSignal.meanClearDamaged.toFixed(2)}; mean "switch" ${referenceSignal.meanSwitch.toFixed(2)}; clear < 0.5/0.6/0.7 — damaged ${Object.values(referenceSignal.damagedClearBelow).join("/")}, original ${Object.values(referenceSignal.cleanClearBelow).join("/")}`,
  ].join("\n")
  writeFileSync(`${outBase}.md`, md)
  console.log(md)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
