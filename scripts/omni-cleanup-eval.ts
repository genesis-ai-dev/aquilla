// Third arm of the zero-shot question (AQU-2222): CTC + the app's LLM cleanup.
//
//   OPENROUTER_API_KEY=… npx tsx scripts/omni-cleanup-eval.ts compare.json [--model openai/gpt-5.6-luna] [--language Blackfoot] [--max-tokens 1200]
//
// compare.json is infra/selfhost/compare_zs.py's output: test clips with the
// reference, CTC and ZS text, plus a pool of every clip CTC heard. For each
// test clip this builds the cleanup prompt exactly as production does
// (buildCleanupMessages / parseCleanupResult from src/lib/transcript-cleanup),
// with the 8 pool pairs whose heard text overlaps most — pickCleanupPairs'
// rule — and never the clip itself. Then it scores all three arms by CER.
//
// It calls OpenRouter directly with the request body auth-worker's
// /api/v1/ai/transcript-cleanup sends, so it costs real (small) money.

import { readFileSync, writeFileSync } from "node:fs"
import {
  buildCleanupMessages,
  CLEANUP_MAX_PAIRS,
  CLEANUP_MAX_TOKENS,
  parseCleanupResult,
  type CleanupPair,
} from "../src/lib/transcript-cleanup/prompt"

interface Row { audio: string; ref: string; ctc: string; zs: string; audioSec: number; ctcSec: number; zsSec: number }
interface PoolItem { audio: string; heard: string; corrected: string }

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const file = process.argv[2]
const model = arg("--model", "openai/gpt-5.6-luna")
const maxTokens = Number(arg("--max-tokens", String(CLEANUP_MAX_TOKENS)))
const language = arg("--language", "Blackfoot")
const key = process.env.OPENROUTER_API_KEY
if (!file || !key) throw new Error("usage: OPENROUTER_API_KEY=… tsx scripts/omni-cleanup-eval.ts compare.json")

const { test, pool } = JSON.parse(readFileSync(file, "utf8")) as { test: Row[]; pool: PoolItem[] }

/** CTC and the cleanup output carry no case or punctuation that the reference
 *  must match, so compare letters only (as infra/selfhost/bench_cpu.py does). */
const normalize = (s: string) =>
  s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean).join(" ")

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    prev = cur
  }
  return prev[b.length]
}

const wordSet = (s: string) => new Set(normalize(s).split(" ").filter(Boolean))

function pairsFor(row: Row): CleanupPair[] {
  const words = wordSet(row.ctc)
  return pool
    .filter((p) => p.audio !== row.audio && normalize(p.heard) !== normalize(p.corrected))
    .map((p) => ({ p, overlap: [...wordSet(p.heard)].filter((w) => words.has(w)).length }))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, CLEANUP_MAX_PAIRS)
    .map(({ p }) => ({ heard: p.heard, corrected: p.corrected }))
}

async function cleanup(row: Row): Promise<{ text: string; kind: string; sec: number; cost: number }> {
  const messages = buildCleanupMessages({ heard: row.ctc, language, pairs: pairsFor(row), correctedOnly: [], terms: [], context: [] })
  const started = Date.now()
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages, temperature: 0, max_tokens: maxTokens, stream: false,
      response_format: { type: "json_object" }, usage: { include: true },
    }),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[]
    usage?: { cost?: number; completion_tokens_details?: { reasoning_tokens?: number } }
  }
  const result = parseCleanupResult(data.choices?.[0]?.message?.content ?? "", row.ctc)
  // As in production: anything but "ok" leaves the heard text in place. A
  // reasoning model can spend the whole token cap thinking; "length" says so.
  const finish = data.choices?.[0]?.finish_reason ?? "?"
  const kind = result.kind === "invalid" && finish === "length" ? "invalid (cut off at max_tokens)" : result.kind
  console.error(`  reasoning tokens ${data.usage?.completion_tokens_details?.reasoning_tokens ?? "?"}, finish ${finish}`)
  return { text: result.kind === "ok" ? result.text : row.ctc, kind, sec: (Date.now() - started) / 1000, cost: data.usage?.cost ?? 0 }
}

const out: (Row & { cleaned: string; cleanupKind: string; cleanupSec: number; cleanupCost: number })[] = []
for (const [n, row] of test.entries()) {
  const c = await cleanup(row)
  out.push({ ...row, cleaned: c.text, cleanupKind: c.kind, cleanupSec: c.sec, cleanupCost: c.cost })
  console.error(`cleanup ${n + 1}/${test.length} ${c.kind} ${c.sec.toFixed(1)}s`)
}
writeFileSync(file.replace(/\.json$/, ".scored.json"), JSON.stringify(out, null, 1))

const cer = (pick: (r: (typeof out)[number]) => string) => {
  let errors = 0
  let chars = 0
  for (const r of out) {
    const ref = normalize(r.ref)
    errors += editDistance(ref, normalize(pick(r)))
    chars += ref.length
  }
  return errors / chars
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const audio = out.reduce((a, r) => a + r.audioSec, 0)
const kinds = out.reduce<Record<string, number>>((a, r) => ({ ...a, [r.cleanupKind]: (a[r.cleanupKind] ?? 0) + 1 }), {})
console.log(`${out.length} test clips, ${(audio / 60).toFixed(1)} min of audio; cleanup model ${model}, max_tokens ${maxTokens}; cleanup results ${JSON.stringify(kinds)}`)
console.log("| Arm | CER | Mean s per clip | LLM cost per clip |\n| --- | --- | --- | --- |")
console.log(`| CTC 1B | ${(cer((r) => r.ctc) * 100).toFixed(1)}% | ${mean(out.map((r) => r.ctcSec)).toFixed(2)} | — |`)
console.log(`| CTC 1B + cleanup | ${(cer((r) => r.cleaned) * 100).toFixed(1)}% | ${mean(out.map((r) => r.ctcSec + r.cleanupSec)).toFixed(2)} | $${mean(out.map((r) => r.cleanupCost)).toFixed(5)} |`)
console.log(`| ZS 7B, 10 examples | ${(cer((r) => r.zs) * 100).toFixed(1)}% | ${mean(out.map((r) => r.zsSec)).toFixed(2)} | — |`)
