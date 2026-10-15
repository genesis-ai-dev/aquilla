/**
 * Jev shadow eval (AQU-1701; design doc §10): how well each Bible data
 * question that autopilot asks Jev separates published text from planted
 * errors, before any question may act. Moving a question to "active" in
 * BIBLE_QA_MODES is a separate, reviewed change that cites these numbers.
 *
 *   npx tsx scripts/jev-shadow-eval.ts \
 *     --pack <bible-wiki>/content/bkp/v1 \
 *     --text <ebible>/corpus/eng-engwebp.txt --vref <ebible>/metadata/vref.txt \
 *     [--max-calls 2000] [--samples 150] [--tq-chapters 40] [--questions speaker,tq] \
 *     [--seed 1701] [--concurrency 4] [--out docs/JEV-SHADOW-EVAL-2026-10-06.md] \
 *     [--dump answers.jsonl] [--no-facts] [--no-source] [--dev-vars auth-worker/.dev.vars] [--fake]
 *
 * --dump writes every answer with its case, for adjudicating flags by hand.
 * --no-facts and --no-source are ablations: the cells go without their facts
 * line, or their source, to see whether Jev answers about the source instead
 * of reading the translation.
 *
 * It asks what production asks: the per-cell questions in production's words
 * and request shape (judge-expectations.ts bibleQaRequest), the Translation
 * Questions through production's judgeComprehension, every answer read by
 * decide()'s own parser. Calls go to the decisions endpoint through
 * jev/client.ts, not through decide(), whose rate limit needs Postgres; here
 * --max-calls is the cap, and a HARD one (lib/jev-shadow-eval.ts).
 *
 * Key: OPENROUTER_API_KEY from the environment, else from the auth-worker's
 * .dev.vars. It is never printed. Without a key the script stops; --fake runs
 * every step against a fake Jev, to check the plumbing.
 *
 * tsconfig.node.json excludes this file, as it does the other scripts that
 * import worker modules. Its pure parts are typechecked and tested:
 * lib/jev-shadow-eval.ts, lib/jev-shadow-eval-cases.ts, lib/bible-mutations.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { BkpQuestion } from "../auth-worker/src/lib/bkp/pack-types"
import { judgeComprehension, MAX_TQ_PER_CALL, type ComprehensionCell } from "../auth-worker/src/lib/contextual/judge-comprehension"
import {
  BIBLE_QA_ABSTAIN_BELOW,
  BIBLE_QA_PROMPTS,
  bibleQaRequest,
  outcomeOf,
  type BibleQaDecide,
} from "../auth-worker/src/lib/contextual/judge-expectations"
import { nameIn, PARTICIPANT_PROMPTS } from "../auth-worker/src/lib/contextual/judge-participants"
import { callJev } from "../auth-worker/src/lib/jev/client"
import { decideResultFromBody, type DecideResult, type JevAnswer, type JevQuestion } from "../auth-worker/src/lib/jev/decide"
import { JEV_MODEL } from "../src/lib/completion/seam-request"
import { random, sample } from "./lib/bible-mutations"
import {
  ABSTAIN_BELOW,
  addUsage,
  batchCases,
  CallBudget,
  costOf,
  flaggedAt,
  NO_USAGE,
  recommendMode,
  renderTable,
  runUnits,
  scoreQuestion,
  type AskUnit,
  type EvalCase,
  type EvalUnit,
  type QuestionScore,
  type Usage,
} from "./lib/jev-shadow-eval"
import {
  CELL_QUESTIONS,
  casePairs,
  evalVerses,
  sampleCases,
  type BookLayers,
  type CellCase,
  type EvalVerse,
  type Prompts,
} from "./lib/jev-shadow-eval-cases"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const NT = "MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV".split(" ")
const ALL_QUESTIONS = [...CELL_QUESTIONS, "tq"] as const
/** Cells per call, as check mode batches them (CHECK_CELLS_PER_JEV_CALL). */
const CELLS_PER_CALL = 12
const CALL_TIMEOUT_MS = 30_000

/** What each question's planted error is, for the report. */
const HOW: Readonly<Record<string, string>> = {
  speaker: "Verses where a speech opens with a named speaker (ACAI person) whose name WEB prints; planted: the name swapped for Peter (John for Peter).",
  question: "Verses the Greek marks as a question, WEB with \"?\"; planted: every \"?\" made \".\" (English keeps interrogative word order, so some \"yes\" answers on planted cases may be defensible).",
  negation: "Verses with a Greek negator and an English one; planted: every English negator dropped (\"don’t\" → \"do\", \"nothing\" → \"something\").",
  you_number: "Verses whose Greek \"you\" is all singular or all plural; Tok Pisin \"yu\"/\"yupela\" planted for every English \"you\" (English does not mark the number), then swapped.",
  referent: "Verses where the pack finds an implied subject with a same-gender, same-number look-alike, and WEB puts a pronoun right before that verb's gloss (\"He brought\"); planted: that pronoun made the look-alike's name. The question names the Greek verb's gloss, which WEB may word otherwise.",
  we_inclusive: "Verses where the pack decides the clusivity of every \"we\"; Tok Pisin \"yumi\" (inclusive) / \"mipela\" (exclusive) planted for English \"we\", then swapped.",
  introduced: "Verses with a participant's first mention after a pericope boundary, named in the Greek and in WEB, not in an apposition (\"John the Baptizer\" stays identified without \"John\"); planted: the name made a pronoun.",
  tq: "Whole chapters, one call each as production asks: of the Translation Questions whose verses WEB has, half keep their answer and half (the planted errors) get the answer of a question from another book.",
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function required(name: string): string {
  const value = arg(name)
  if (!value) throw new Error(`missing --${name}; see the header of scripts/jev-shadow-eval.ts`)
  return value
}

function int(name: string, fallback: number): number {
  const value = Number.parseInt(arg(name) ?? String(fallback), 10)
  if (!Number.isFinite(value) || value < 0) {
    console.error(`--${name} must be a whole number`)
    process.exit(2)
  }
  return value
}

/** The key, from the environment or a .dev.vars file. Never printed. */
function loadKey(devVars: string): { key: string | null; baseUrl?: string; from: string } {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim()
  if (fromEnv) return { key: fromEnv, ...(process.env.OPENROUTER_BASE_URL ? { baseUrl: process.env.OPENROUTER_BASE_URL } : {}), from: "the environment" }
  if (!existsSync(devVars)) return { key: null, from: devVars }
  const vars: Record<string, string> = {}
  for (const line of readFileSync(devVars, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line)
    if (match) vars[match[1]] = match[2].replace(/^(["'])(.*)\1$/u, "$2")
  }
  return { key: vars.OPENROUTER_API_KEY || null, ...(vars.OPENROUTER_BASE_URL ? { baseUrl: vars.OPENROUTER_BASE_URL } : {}), from: devVars }
}

/** The eval must judge an answer exactly as production does. */
function checkAgreesWithProduction(): void {
  if (BIBLE_QA_ABSTAIN_BELOW !== ABSTAIN_BELOW) throw new Error("the eval's abstain threshold differs from production's")
  for (let i = 0; i <= 100; i++) {
    for (const passWhenYes of [true, false]) {
      const p = i / 100
      if ((outcomeOf(p, passWhenYes).outcome === "fail") !== flaggedAt({ p, case: { passWhenYes } }, ABSTAIN_BELOW)) {
        throw new Error(`the eval and production judge p=${p} differently`)
      }
    }
  }
}

type Ask = (request: {
  state: Record<string, unknown>
  questions: Record<string, JevQuestion>
  fallback: () => Record<string, JevAnswer>
}) => Promise<{ result: DecideResult; usage: Usage }>

function usageOf(body: unknown): Usage {
  const usage = body && typeof body === "object" ? (body as { usage?: Record<string, unknown> }).usage : undefined
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)
  return { inputTokens: num(usage?.input_tokens) ?? 0, outputTokens: num(usage?.output_tokens) ?? 0, costUsd: num(usage?.cost) }
}

function liveJev(key: string, baseUrl: string | undefined): Ask {
  const env = { OPENROUTER_API_KEY: key, ...(baseUrl ? { OPENROUTER_BASE_URL: baseUrl } : {}) }
  return async ({ state, questions, fallback }) => {
    const called = await callJev(env, { model: JEV_MODEL, state, questions }, CALL_TIMEOUT_MS)
    if (!called.ok) return { result: { answers: fallback(), decidedBy: "heuristic", reason: called.reason, model: null, usage: null }, usage: NO_USAGE }
    return { result: decideResultFromBody(called.body, questions, fallback), usage: usageOf(called.body) }
  }
}

/** --fake: a fixed "yes, 0.8" for every question, through decide()'s parser, to check the plumbing. */
const fakeJev: Ask = async ({ questions, fallback }) => {
  const body = { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.8 }])), usage: { input_tokens: 1, output_tokens: 1 } }
  return { result: decideResultFromBody(body, questions, fallback), usage: usageOf(body) }
}

interface TqCase extends EvalCase {
  question: "tq"
  tq: BkpQuestion
  chapter: string
}

type AnyCase = CellCase | TqCase

/**
 * A batch of cell questions, asked as one span's questions are. `include`
 * false for facts (--no-facts) or source (--no-source) leaves that out of
 * the state: an ablation, to see whether Jev answers about the source
 * instead of reading the translation.
 */
function askCells(jev: Ask, unit: EvalUnit<CellCase>, include: { facts: boolean; source: boolean }): ReturnType<AskUnit<CellCase>> {
  const asks = unit.cases.map((c, index) => ({ key: `c${index}_${c.question}`, index, question: c.prompt }))
  const cells = unit.cases.map((c) => ({
    ref: c.ref,
    source: include.source ? c.source : "",
    text: c.text,
    ...(include.facts ? { factsLine: c.factsLine } : {}),
  }))
  const { state, questions } = bibleQaRequest(cells, asks)
  const fallback = () => Object.fromEntries(asks.map((a) => [a.key, { kind: "noul", p: 0.5 } as JevAnswer]))
  return jev({ state, questions, fallback }).then(({ result, usage }) => ({
    // As production reads them: a fallback, or an exact 0.5, is no answer.
    p: asks.map((a) => {
      const answer = result.answers[a.key]
      return result.decidedBy !== "heuristic" && answer?.kind === "noul" && answer.p !== 0.5 ? answer.p : null
    }),
    usage,
  }))
}

/** A chapter's Translation Questions, through production's judgeComprehension. */
async function askChapter(
  jev: Ask,
  unit: EvalUnit<TqCase>,
  cells: ReadonlyMap<string, ComprehensionCell[]>,
  packVersion: string,
): ReturnType<AskUnit<TqCase>> {
  let usage = NO_USAGE
  const decide: BibleQaDecide = async (input) => {
    const answered = await jev(input)
    usage = addUsage(usage, answered.usage)
    return answered.result
  }
  const chapterCells = cells.get(unit.cases[0].chapter) ?? []
  const result = await judgeComprehension(
    {
      questions: unit.cases.map((c) => c.tq),
      cells: chapterCells,
      checked: new Set(chapterCells.map((c) => c.cellId)),
      owner: "touches",
      traceSpanId: `eval:${unit.cases[0].chapter}`,
    },
    { packVersion, decide, cache: new Map() },
  )
  const pById = new Map(result.judgments.map((j) => [j.tq, j.decidedBy === "jev" ? (j.p ?? null) : null]))
  return { p: unit.cases.map((c) => pById.get(c.tq.id) ?? null), usage }
}

function readLayer<T>(packDir: string, layer: string, book: string): T | null {
  const path = join(packDir, layer, `${book}.json`)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null
}

/** Round-robin over the questions, so a run that reaches the cap has some of every question. */
function interleave<T>(lists: readonly T[][]): T[] {
  const out: T[] = []
  for (let i = 0; lists.some((list) => i < list.length); i++) for (const list of lists) if (i < list.length) out.push(list[i])
  return out
}

/**
 * C1's planted error: the question keeps its verses, and gets the answer of a
 * question half the New Testament away, in another book. Null when none is.
 */
function swapIn(tq: BkpQuestion, all: readonly BkpQuestion[], index: number): BkpQuestion | null {
  const book = tq.refs[0].split(" ")[0]
  const half = Math.floor(all.length / 2)
  for (let shift = half; shift < all.length + half; shift++) {
    const other = all[(index + shift) % all.length]
    if (other.refs[0].split(" ")[0] !== book) return { id: `${tq.id}~swap`, refs: tq.refs, q: tq.q, a: other.a }
  }
  return null
}

async function main(): Promise<void> {
  const packDir = required("pack")
  const textLines = readFileSync(required("text"), "utf8").split("\n")
  const vrefLines = readFileSync(required("vref"), "utf8").split("\n")
  const maxCalls = int("max-calls", 2000)
  const samples = int("samples", 150)
  const tqChapters = int("tq-chapters", 40)
  const seed = int("seed", 1701)
  const concurrency = Math.max(1, int("concurrency", 4))
  const questions = (arg("questions")?.split(",") ?? [...ALL_QUESTIONS]).filter((q): q is (typeof ALL_QUESTIONS)[number] =>
    (ALL_QUESTIONS as readonly string[]).includes(q),
  )
  const fake = process.argv.includes("--fake")
  const withFacts = !process.argv.includes("--no-facts")
  const withSource = !process.argv.includes("--no-source")
  const out = arg("out")
  /** --dump <file.jsonl>: every answer with its case, for adjudicating flags by hand (design doc §10). */
  const dump = arg("dump")

  checkAgreesWithProduction()
  const auth = loadKey(resolve(arg("dev-vars") ?? join(REPO, "auth-worker/.dev.vars")))
  if (!fake && !auth.key) {
    console.error(`No Jev key: set OPENROUTER_API_KEY or point --dev-vars at an auth-worker .dev.vars (looked in ${auth.from}). The real run is pending a key; --fake checks the plumbing.`)
    process.exit(2)
  }
  const jev = fake ? fakeJev : liveJev(auth.key ?? "", auth.baseUrl)
  console.log(fake ? "Jev: FAKE (every answer 0.8; the numbers mean nothing)" : `Jev: ${JEV_MODEL}, key configured (from ${auth.from})`)

  const manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8")) as { version: string; books: Record<string, { layers: string[] }> }
  const web = new Map<string, { ref: string; text: string }[]>()
  vrefLines.forEach((ref, i) => {
    const text = (textLines[i] ?? "").trim()
    if (!ref || !text || text === "<range>") return
    const book = ref.split(" ")[0]
    web.set(book, [...(web.get(book) ?? []), { ref, text }])
  })

  const verses: EvalVerse[] = []
  const tqByChapter = new Map<string, BkpQuestion[]>()
  const chapterCells = new Map<string, ComprehensionCell[]>()
  for (const book of NT) {
    const entry = manifest.books[book]
    const bookWeb = web.get(book)
    if (!entry || !bookWeb || !["voices", "structure", "people", "text"].every((l) => entry.layers.includes(l))) continue
    const layers: BookLayers = {
      voices: readLayer(packDir, "voices", book) as BookLayers["voices"],
      structure: readLayer(packDir, "structure", book) as BookLayers["structure"],
      people: readLayer(packDir, "people", book) as BookLayers["people"],
      text: readLayer(packDir, "text", book) as BookLayers["text"],
    }
    const bookVerses = evalVerses(layers, bookWeb)
    verses.push(...bookVerses)
    const notes = entry.layers.includes("notes") ? readLayer<{ questions: BkpQuestion[] }>(packDir, "notes", book) : null
    const withText = new Map(bookVerses.map((v) => [v.ref, v.text]))
    for (const v of bookVerses) {
      const chapter = v.ref.replace(/:\d+$/u, "")
      chapterCells.set(chapter, [...(chapterCells.get(chapter) ?? []), { cellId: v.ref, refs: [v.ref], text: v.text }])
    }
    for (const tq of notes?.questions ?? []) {
      if (!tq.refs.every((ref) => withText.has(ref))) continue
      const chapter = tq.refs[0].replace(/:\d+$/u, "")
      tqByChapter.set(chapter, [...(tqByChapter.get(chapter) ?? []), tq])
    }
  }

  const rand = random(seed)
  const prompts: Prompts = { ...BIBLE_QA_PROMPTS, ...PARTICIPANT_PROMPTS, name: nameIn }
  const unitLists: EvalUnit<AnyCase>[][] = []
  const available: Record<string, number> = {}
  for (const question of CELL_QUESTIONS) {
    if (!questions.includes(question)) continue
    const pairs = casePairs(question, verses, prompts)
    available[question] = pairs.length
    // Shuffled before batching, so a call mixes published verses and planted errors, as production's calls mix right and wrong.
    const cases = sampleCases(pairs, samples, rand)
    const mixed = sample(cases, cases.length, rand)
    unitLists.push(batchCases(mixed, CELLS_PER_CALL).map((batch) => ({ question, cases: batch, calls: 1 })))
  }
  if (questions.includes("tq")) {
    available.tq = tqByChapter.size
    const all = [...tqByChapter.values()].flat()
    const indexOf = new Map(all.map((tq, i) => [tq.id, i]))
    // One call per chapter, as production asks; in each, half the questions keep their answer and half get another book's.
    unitLists.push(
      sample([...tqByChapter.keys()].sort(), tqChapters, rand).map((chapter) => {
        const tqs = sample(tqByChapter.get(chapter) ?? [], Number.MAX_SAFE_INTEGER, rand)
        const cases: TqCase[] = tqs.flatMap((tq, i): TqCase[] => {
          const base = { question: "tq" as const, passWhenYes: true, ref: chapter, chapter }
          if (i % 2 === 0) return [{ ...base, kind: "correct", tq }]
          const swapped = swapIn(tq, all, indexOf.get(tq.id) ?? 0)
          return swapped ? [{ ...base, kind: "planted", tq: swapped }] : []
        })
        return { question: "tq", cases, calls: Math.ceil(cases.length / MAX_TQ_PER_CALL) }
      }),
    )
  }

  const units = interleave(unitLists)
  const planned = units.reduce((n, unit) => n + unit.calls, 0)
  console.log(`${verses.length} WEB verses with pack facts; ${units.length} units, ${planned} calls planned; cap ${maxCalls}`)
  const budget = new CallBudget(maxCalls)
  const ask: AskUnit<AnyCase> = (unit) =>
    unit.question === "tq"
      ? askChapter(jev, unit as EvalUnit<TqCase>, chapterCells, manifest.version)
      : askCells(jev, unit as EvalUnit<CellCase>, { facts: withFacts, source: withSource })
  const started = Date.now()
  const run = await runUnits(units, ask, budget, concurrency)
  const scores: QuestionScore[] = questions.map((q) => scoreQuestion(q, run))
  if (dump) {
    const line = ({ case: c, p }: (typeof run.answered)[number]) =>
      JSON.stringify({
        question: c.question,
        kind: c.kind,
        ref: c.ref,
        passWhenYes: c.passWhenYes,
        p,
        ...(c.question === "tq" ? { tq: c.tq.id, q: c.tq.q, a: c.tq.a } : { prompt: c.prompt, text: c.text }),
      })
    writeFileSync(resolve(dump), `${run.answered.map(line).join("\n")}\n`)
  }

  const totalCost = scores.reduce((sum, s) => sum + costOf(s).usd, 0)
  const estimated = scores.some((s) => costOf(s).estimated && s.calls > 0)
  const report = [
    "# Jev shadow eval: Bible data questions (AQU-1701)",
    "",
    `- Run: ${new Date().toISOString().slice(0, 10)}, ${fake ? "FAKE Jev (plumbing check only)" : `model ${JEV_MODEL}`}, pack ${manifest.version}, the World English Bible NT (eng-engwebp, public domain).`,
    `- Calls: ${budget.used} of a cap of ${maxCalls}${run.capped ? " (cap reached: the cases left are listed as not asked)" : ""}; ${run.errors} failed outright; ${((Date.now() - started) / 1000).toFixed(0)} s.`,
    `- Cost: ${estimated ? "≈ " : ""}$${totalCost.toFixed(4)}${estimated ? " (estimated at $0.00003 a call: the responses reported no cost)" : " (as the responses reported it)"}.`,
    `- Cases: up to ${samples} published verses per question and their planted twins (seed ${seed}); C1: ${tqChapters} chapters, half of each one's questions with an answer from another book. ${CELLS_PER_CALL} cells per call, one call per chapter for C1, never a verse beside its planted twin.`,
    `- State: ${withFacts && withSource ? "as production sends it: each cell's source, translation and facts line" : `ABLATION: the cells without their ${[withFacts ? "" : "facts line (--no-facts)", withSource ? "" : "source (--no-source)"].filter(Boolean).join(" or ")}`}.`,
    "",
    "A flag is a \"no\" at the band's certainty |p − 0.5|·2. Precision: flags on planted errors over all flags. Recall: flags on planted errors over all planted errors (an abstention is a miss). Abstain: answers below certainty 0.4, as production abstains.",
    "",
    renderTable(scores),
    "",
    "## Recommended mode per question",
    "",
    "BIBLE_QA_MODES stays all \"shadow\" in this branch; changing it is a separate, reviewed change.",
    "",
    ...scores.map((s) => {
      const r = recommendMode(s)
      return `- **${s.question}**: ${r.mode} — ${r.why}.${s.notAsked > 0 ? ` ${s.notAsked} cases not asked (cap).` : ""}`
    }),
    "",
    "## How each question was tested",
    "",
    ...questions.map((q) => `- **${q}** (${available[q] ?? 0} ${q === "tq" ? "chapters" : "verses"} qualified): ${HOW[q]}`),
    "",
    "## Reproduce",
    "",
    "```",
    `npx tsx scripts/jev-shadow-eval.ts --pack <bible-wiki>/content/bkp/v1 --text <ebible>/corpus/eng-engwebp.txt --vref <ebible>/metadata/vref.txt --max-calls ${maxCalls} --samples ${samples} --tq-chapters ${tqChapters} --seed ${seed}${withFacts ? "" : " --no-facts"}${withSource ? "" : " --no-source"}`,
    "```",
    "",
  ].join("\n")
  console.log(report)
  if (out) {
    writeFileSync(resolve(out), report)
    console.log(`wrote ${out}`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
