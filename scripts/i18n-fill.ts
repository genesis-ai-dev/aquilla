/**
 * The fill: translate what dev's English has that a locale does not (AQU-2792).
 *
 *   pnpm i18n:fill [dir] [--locale <code>]… [--dry-run]      (default dir: i18n-todo/)
 *
 * A pull request adds English and its context notes and nothing else. Once it
 * is on dev, .github/workflows/i18n-fill.yml runs this, and it does what an
 * author used to do by hand in every branch:
 *
 *   1. `pnpm i18n:todo --new` writes one packet per locale: every string the
 *      translation baseline does not allow to be English.
 *   2. A model translates each packet (scripts/lib/i18n-fill.ts has the prompt
 *      and the checks an answer must pass).
 *   3. `pnpm i18n:import-todo` writes the catalogs, the source hashes and the
 *      baseline, the same generated files a hand import writes.
 *   4. A string the model returned unchanged (a product name, a format) is
 *      recorded in the baseline as deliberately English, and the baseline is
 *      pruned of entries that are no longer gaps.
 *
 * The result is unreviewed machine translation, as every catalog is today
 * (docs/swarm/I18N-TRANSLATION-PROVENANCE.md). A native-speaker review replaces
 * it through the same import.
 *
 * It exits 0 when it ran, whatever it could not translate: those strings are
 * listed, left in English, and tried again by the next run. `pnpm
 * i18n:coverage` is the command that fails while any are left.
 *
 * The model is reached through three variables, all required, none defaulted:
 * an unset base URL once sent a key to the wrong provider (#716).
 *
 *   I18N_FILL_API_KEY    the key
 *   I18N_FILL_BASE_URL   an OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1
 *   I18N_FILL_MODEL      the model id at that endpoint
 *
 * `--dry-run` stops after step 2 and leaves the filled packets in `dir` to read.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { CATALOG_SOURCE_ROOT } from "../src/lib/i18n/catalog-export"
import { DEFAULT_LOCALE, isSupportedLocale } from "../src/lib/i18n/locales"
import { CATALOGS } from "../src/lib/i18n/messages/all"
import { fillPacket, keptKeys, type ChatMessage, type FillResult, type Packet } from "./lib/i18n-fill"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_DIR = "i18n-todo"
/** Locales translated at once. Each is its own sequence of requests. */
const LOCALES_AT_ONCE = 4
const REQUEST_TIMEOUT_MS = 240_000

function fail(message: string): never {
  console.error(`i18n-fill: ${message}`)
  process.exit(1)
}

/** Run one of the sibling i18n commands, in a fresh process so it reads the files as they now are. */
function run(script: string, args: string[]): void {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", script), ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  })
  if (result.status !== 0) fail(`${script} ${args.join(" ")} exited ${result.status ?? result.signal}`)
}

function modelFromEnv(): (messages: ChatMessage[]) => Promise<string> {
  const key = process.env.I18N_FILL_API_KEY?.trim()
  const baseUrl = process.env.I18N_FILL_BASE_URL?.trim().replace(/\/+$/, "")
  const model = process.env.I18N_FILL_MODEL?.trim()
  if (!key || !baseUrl || !model) {
    fail("set I18N_FILL_API_KEY, I18N_FILL_BASE_URL and I18N_FILL_MODEL (see the top of scripts/i18n-fill.ts)")
  }
  return async (messages) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: 16_000 }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.ok) {
        const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
        const text = body.choices?.[0]?.message?.content
        if (typeof text === "string" && text.length > 0) return text
        throw new Error("the model returned no text")
      }
      const busy = response.status === 429 || response.status >= 500
      if (!busy || attempt === 2) {
        throw new Error(`HTTP ${response.status} from the model: ${(await response.text()).slice(0, 300)}`)
      }
      await new Promise((done) => setTimeout(done, 2_000 * 2 ** attempt))
    }
  }
}

function readPackets(dir: string, only: string[]): Packet[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".todo.json"))
    .map((name) => name.slice(0, -".todo.json".length))
    .filter((locale) => isSupportedLocale(locale) && locale !== DEFAULT_LOCALE)
    .filter((locale) => only.length === 0 || only.includes(locale))
    .sort()
    .map((locale) => {
      const file = JSON.parse(readFileSync(join(dir, `${locale}.todo.json`), "utf8")) as Record<string, Record<string, string>>
      const notes = JSON.parse(readFileSync(join(dir, `${locale}.todo.notes.json`), "utf8")) as Record<string, string>
      return { locale, messages: file[CATALOG_SOURCE_ROOT] ?? {}, notes }
    })
}

async function inGroups<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const at = next++
        results[at] = await work(items[at])
      }
    }),
  )
  return results
}

/** The run in words: the step summary, and the body of the pull request the workflow opens. */
function summarize(results: FillResult[], packets: Packet[], model: string): string {
  const total = (pick: (r: FillResult) => number) => results.reduce((sum, r) => sum + pick(r), 0)
  const translated = total((r) => Object.keys(r.translated).length)
  const lines = [
    `Translated ${translated} string(s) across ${results.length} locale(s) with \`${model}\`. ` +
      `These are unreviewed machine translations, like the rest of each catalog.`,
    "",
    "| Locale | Translated | Kept in English | Not translated |",
    "| --- | ---: | ---: | ---: |",
    ...results.map((r) => `| ${r.locale} | ${Object.keys(r.translated).length} | ${r.kept.length} | ${r.failed.length} |`),
  ]
  const keptByKey = new Map<string, string[]>()
  results.forEach((r, at) => {
    for (const key of keptKeys(packets[at], r)) keptByKey.set(key, [...(keptByKey.get(key) ?? []), r.locale])
  })
  if (keptByKey.size > 0) {
    lines.push("", "**Kept in English** (the model returned these unchanged; recorded in `translation-baseline.json`):", "")
    for (const [key, locales] of keptByKey) lines.push(`- \`${key}\`: ${locales.join(", ")}`)
  }
  const failed = results.flatMap((r) => r.failed.map((f) => `- ${r.locale} \`${f.leaf}\`: ${f.issue}`))
  if (failed.length > 0) {
    lines.push("", "**Not translated** (left in English; the next run tries again):", "", ...failed.slice(0, 200))
    if (failed.length > 200) lines.push(`- … and ${failed.length - 200} more`)
  }
  return lines.join("\n") + "\n"
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const only: string[] = []
  const positional: string[] = []
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "--locale") only.push(args[++at] ?? fail("--locale needs a locale code"))
    else if (!args[at].startsWith("--")) positional.push(args[at])
  }
  const dir = resolve(REPO_ROOT, positional[0] ?? DEFAULT_DIR)

  // A packet left by an earlier run would be imported again with whatever it held.
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir)) if (/\.todo(\.notes)?\.json$/.test(name)) rmSync(join(dir, name))
  run("i18n-todo.ts", [dir, "--new"])

  const packets = readPackets(dir, only)
  const summaryPath = join(dir, "fill-summary.md")
  if (packets.length === 0) {
    console.log("i18n-fill: nothing to translate.")
    if (!dryRun) run("i18n-catalog.ts", ["baseline"])
    writeFileSync(summaryPath, "Nothing to translate. The translation baseline was pruned of entries that are no longer gaps.\n", "utf8")
    return
  }

  const complete = modelFromEnv()
  const model = process.env.I18N_FILL_MODEL?.trim() ?? ""
  const results = await inGroups(packets, LOCALES_AT_ONCE, async (packet) => {
    const result = await fillPacket(packet, CATALOGS[packet.locale] ?? {}, complete)
    console.log(
      `i18n-fill: ${packet.locale} — ${Object.keys(result.translated).length} translated, ` +
        `${result.kept.length} kept in English, ${result.failed.length} not translated`,
    )
    return result
  })

  results.forEach((result, at) => {
    const messages = { ...packets[at].messages, ...result.translated }
    writeFileSync(
      join(dir, `${result.locale}.todo.json`),
      JSON.stringify({ [CATALOG_SOURCE_ROOT]: messages }, null, 2) + "\n",
      "utf8",
    )
  })

  const summary = summarize(results, packets, model)
  writeFileSync(summaryPath, summary, "utf8")
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8")
  console.log(`\n${summary}`)
  if (dryRun) {
    console.log(`i18n-fill: dry run. The filled packets are in ${dir}; nothing was imported.`)
    return
  }

  run("i18n-catalog.ts", ["import-todo", dir])
  // The importer drops a value equal to English, so "deliberately English" can
  // only be recorded in the baseline. One locale at a time: a key kept in
  // French is still a gap to translate in Thai.
  results.forEach((result, at) => {
    const keys = keptKeys(packets[at], result)
    if (keys.length > 0) run("i18n-catalog.ts", ["baseline", "--allow", ...keys, "--locale", result.locale])
  })
  run("i18n-catalog.ts", ["baseline"])

  const left = results.reduce((sum, r) => sum + r.failed.length, 0)
  if (left > 0) console.log(`\ni18n-fill: ${left} string(s) were not translated. pnpm i18n:coverage lists what is left.`)
}

await main()
