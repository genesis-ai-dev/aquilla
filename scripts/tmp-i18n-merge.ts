/**
 * Temporary batch-merge helper: validate subagent key manifests and emit the
 * `keys:` / `context.keys:` blocks to splice into each namespace module.
 *
 * Usage: npx tsx scripts/tmp-i18n-merge.ts /tmp/i18n-batch/<batch> [--apply]
 *
 * Without `--apply` it only validates and writes the blocks to a scratch file
 * for review. With `--apply` it also splices them into the namespace modules,
 * appending to the end of each module's `keys` and `context.keys` objects. Run
 * `pnpm i18n:check` + the i18n suite afterwards — the splice is textual and
 * deliberately dumb, so those are what actually prove the result.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { en } from "../src/lib/i18n/messages/en"
import { NAMESPACES } from "../src/lib/i18n/namespaces"
import { isPluralMessage, PLURAL_CATEGORIES, type MessageValue } from "../src/lib/i18n/plurals"
import { DUPLICATE_EXCEPTIONS } from "../src/lib/i18n/namespaces/duplicate-exceptions"

interface Entry {
  key: string
  en: string
  description: string
  placeholders?: Record<string, string>
  plural?: { countVar?: string; forms: Record<string, string> }
  duplicateOf?: string
  whyDifferent?: string
}
interface Manifest {
  file?: string
  files?: string[]
  newKeys?: Entry[]
  reusedKeys?: { key: string; en: string; sites?: number }[]
  exempted?: { text: string; reason: string }[]
}

const dir = process.argv[2]
if (!dir) throw new Error("usage: tmp-i18n-merge.ts <manifest-dir> [--apply]")
const apply = process.argv.includes("--apply")

const manifests = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8")) as Manifest] as const)

const problems: string[] = []
/** Declared duplicates: each needs a `duplicate-exceptions.ts` entry at merge. */
const owedExceptions: { key: string; collidesWith: string[]; english: string; reason: string }[] = []
const entries = new Map<string, { entry: Entry; from: string }>()

for (const [name, m] of manifests) {
  for (const e of m.newKeys ?? []) {
    if (entries.has(e.key)) {
      problems.push(`${e.key}: defined in both ${entries.get(e.key)!.from} and ${name}`)
      continue
    }
    entries.set(e.key, { entry: e, from: name })
  }
}

const placeholdersIn = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
const flat = (v: MessageValue): string[] =>
  isPluralMessage(v)
    ? PLURAL_CATEGORIES.flatMap((c) => (v.forms[c] === undefined ? [] : [v.forms[c]!]))
    : [v]

/** normalized English → keys already in the catalog that render it */
const existingByEnglish = new Map<string, string[]>()
for (const ns of NAMESPACES) {
  for (const [key, value] of Object.entries(ns.keys)) {
    for (const s of flat(value as MessageValue)) {
      const n = s.trim().toLowerCase()
      existingByEnglish.set(n, [...(existingByEnglish.get(n) ?? []), key])
    }
  }
}

/**
 * normalized English → NEW keys in this batch that render it. Two agents
 * working disjoint files can still mint the same English independently, and
 * the catalog-side check above cannot see that because neither key exists yet.
 */
const formsOf = (e: Entry): string[] => (e.plural ? Object.values(e.plural.forms) : [e.en])
const newByEnglish = new Map<string, string[]>()
for (const [key, { entry }] of entries) {
  for (const s of formsOf(entry)) {
    const n = s.trim().toLowerCase()
    newByEnglish.set(n, [...(newByEnglish.get(n) ?? []), key])
  }
}

const byNamespace = new Map<string, Entry[]>()

for (const [key, { entry, from }] of entries) {
  const where = `${from} → ${key}`
  const ns = key.split(".")[0]
  if (!NAMESPACES.some((n) => Object.keys(n.keys).some((k) => k.startsWith(`${ns}.`)))) {
    problems.push(`${where}: unknown namespace "${ns}"`)
  }
  if (key in en) problems.push(`${where}: already exists in the en catalog`)
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(key)) problems.push(`${where}: malformed key name`)
  if ((entry.description ?? "").trim().length < 60) {
    problems.push(`${where}: description under 60 chars`)
  }

  const forms = entry.plural ? Object.values(entry.plural.forms) : [entry.en]
  if (entry.plural) {
    if (!entry.plural.forms.other) problems.push(`${where}: plural is missing the "other" form`)
    for (const c of Object.keys(entry.plural.forms)) {
      if (!PLURAL_CATEGORIES.includes(c as never)) problems.push(`${where}: bad plural category "${c}"`)
    }
    const sig = (s: string) => [...new Set(placeholdersIn(s))].sort().join(",")
    const first = sig(forms[0])
    for (const f of forms) {
      if (sig(f) !== first) problems.push(`${where}: plural forms disagree on placeholders`)
    }
    const countVar = entry.plural.countVar ?? "count"
    if (!placeholdersIn(forms[0]).includes(countVar)) {
      problems.push(`${where}: plural countVar {${countVar}} is absent from the forms`)
    }
  }

  const used = [...new Set(forms.flatMap(placeholdersIn))]
  const documented = Object.keys(entry.placeholders ?? {})
  for (const p of used) {
    if (!documented.includes(p)) problems.push(`${where}: placeholder {${p}} is not documented`)
  }
  for (const p of documented) {
    if (!used.includes(p)) problems.push(`${where}: documents unused placeholder {${p}}`)
  }

  for (const s of forms) {
    const norm = s.trim().toLowerCase()
    const collide = existingByEnglish.get(norm) ?? []
    // no-duplicates.test.ts allows ONE unexcused key per colliding group, so a
    // collision against an already-excused key needs nothing from us.
    const unexcused = collide.filter((k) => !(k in DUPLICATE_EXCEPTIONS))
    if (unexcused.length > 0) {
      if (entry.duplicateOf) {
        owedExceptions.push({
          key,
          collidesWith: unexcused,
          english: s,
          reason: entry.whyDifferent ?? "",
        })
        if ((entry.whyDifferent ?? "").trim().length <= 60) {
          problems.push(
            `${where}: declared duplicateOf ${entry.duplicateOf} but whyDifferent is ` +
              `missing or under 60 chars — no-duplicates.test.ts rejects that reason`,
          )
        }
      } else {
        problems.push(
          `${where}: English "${s}" collides with ${unexcused.join(", ")} — NOT declared; ` +
            `reuse the existing key or justify the split`,
        )
      }
    }
    const twins = (newByEnglish.get(norm) ?? []).filter((k) => k !== key)
    if (twins.length > 0) {
      problems.push(
        `${where}: English "${s}" collides with NEW key(s) ${twins.join(", ")} in this same ` +
          `batch — pick one and have the other call it, or justify the split`,
      )
    }
  }

  byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), entry])
}

const q = (s: string) => JSON.stringify(s)
/** Wrap a long string as a `+`-concatenated literal, matching catalog style. */
const wrap = (s: string, indent: string): string => {
  if (s.length <= 76) return q(s)
  const words = s.split(" ")
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    if ((cur + " " + w).trim().length > 72) {
      lines.push(cur.trim())
      cur = w
    } else cur = `${cur} ${w}`
  }
  if (cur.trim()) lines.push(cur.trim())
  return lines.map((l, i) => `${i === 0 ? "" : indent}${q(i === lines.length - 1 ? l : `${l} `)}`).join(" +\n")
}

const renderKey = (e: Entry): string => {
  if (!e.plural) return `    ${q(e.key)}: ${wrap(e.en, "      ")},`
  const forms = PLURAL_CATEGORIES.filter((c) => e.plural!.forms[c] !== undefined)
    .map((c) => `      ${c}: ${q(e.plural!.forms[c]!)},`)
    .join("\n")
  const cv = e.plural.countVar ?? "count"
  // `plural()` defaults its count variable to "count", and the catalog omits
  // the argument in that case — emit the same shape rather than a redundant one.
  return cv === "count"
    ? `    ${q(e.key)}: plural({\n${forms}\n    }),`
    : `    ${q(e.key)}: plural(\n      {\n${forms}\n      },\n      ${q(cv)},\n    ),`
}

const renderContext = (e: Entry): string => {
  const desc = wrap(e.description.trim(), "          ")
  if (!e.placeholders || Object.keys(e.placeholders).length === 0) {
    return `      ${q(e.key)}: {\n        description:\n          ${desc},\n      },`
  }
  const ph = Object.entries(e.placeholders)
    .map(([n, v]) => `          ${n}: ${wrap(v, "            ")},`)
    .join("\n")
  return `      ${q(e.key)}: {\n        description:\n          ${desc},\n        placeholders: {\n${ph}\n        },\n      },`
}

const out: string[] = []
/** namespace → the two blocks to splice, kept so `--apply` reuses this output. */
const blocks = new Map<string, { keys: string; context: string; count: number }>()
for (const [ns, list] of [...byNamespace].sort()) {
  list.sort((a, b) => a.key.localeCompare(b.key))
  const keysBlock = list.map(renderKey).join("\n")
  const contextBlock = list.map(renderContext).join("\n")
  blocks.set(ns, { keys: keysBlock, context: contextBlock, count: list.length })
  out.push(`\n${"=".repeat(78)}\nNAMESPACE ${ns} — ${list.length} new key(s)\n${"=".repeat(78)}`)
  out.push(`\n--- keys: (splice into src/lib/i18n/namespaces/${ns}.ts) ---\n`)
  out.push(keysBlock)
  out.push(`\n--- context.keys: (splice into the same file) ---\n`)
  out.push(contextBlock)
}

const reused = new Map<string, number>()
const exempted: string[] = []
for (const [, m] of manifests) {
  for (const r of m.reusedKeys ?? []) reused.set(r.key, (reused.get(r.key) ?? 0) + (r.sites ?? 1))
  for (const x of m.exempted ?? []) exempted.push(`${x.text} — ${x.reason}`)
}

console.log(
  `manifests: ${manifests.length}   new keys: ${entries.size}   reused: ${reused.size}   exempted: ${exempted.length}`,
)
for (const [key, sites] of [...reused].sort()) {
  if (!(key in en)) console.log(`  REUSED KEY DOES NOT EXIST: ${key}`)
  else console.log(`  reused ${key} (${sites} site(s))`)
}
if (problems.length > 0) {
  console.log(`\n${problems.length} PROBLEM(S):`)
  for (const p of problems) console.log(`  • ${p}`)
} else {
  console.log("\nno problems found.")
}

if (owedExceptions.length > 0) {
  console.log(
    `\n${owedExceptions.length} DUPLICATE-EXCEPTION ENTR(IES) OWED ` +
      `(append to src/lib/i18n/namespaces/duplicate-exceptions.ts):`,
  )
  for (const o of owedExceptions) {
    console.log(`  • ${o.key} — "${o.english}" vs ${o.collidesWith.join(", ")}`)
  }
  out.push(`\n${"=".repeat(78)}\nDUPLICATE_EXCEPTIONS entries owed\n${"=".repeat(78)}\n`)
  for (const o of owedExceptions) {
    out.push(`  // "${o.english}" vs ${o.collidesWith.join(", ")}`)
    out.push(`  ${q(o.key)}:\n    ${wrap(o.reason.trim(), "    ")},`)
  }
}

/**
 * Splice a block in at the end of an object literal, located by the line that
 * closes it. Every namespace module has the same shape — `keys: { … },`
 * immediately before `context: {`, and `context.keys: { … },` immediately
 * before the `},` that closes `context` — so both closers can be found by
 * their following line instead of by matching braces.
 */
function spliceAtObjectEnd(lines: string[], closer: RegExp, next: RegExp, block: string): string[] {
  for (let i = 0; i < lines.length - 1; i++) {
    if (closer.test(lines[i]) && next.test(lines[i + 1])) {
      return [...lines.slice(0, i), ...block.split("\n"), ...lines.slice(i)]
    }
  }
  throw new Error(`could not find the object closer ${closer} followed by ${next}`)
}

if (apply) {
  if (problems.length > 0) throw new Error("refusing to --apply while problems remain")
  const labelArg = process.argv.find((a) => a.startsWith("--label="))
  const stamp = `    // — ${labelArg?.slice("--label=".length) ?? `${dir.split("/").pop()} batch`} —`
  for (const [ns, b] of blocks) {
    const path = `src/lib/i18n/namespaces/${ns}.ts`
    let lines = readFileSync(path, "utf8").split("\n")
    lines = spliceAtObjectEnd(lines, /^ {2}},$/, /^ {2}context: \{$/, `\n${stamp}\n${b.keys}`)
    lines = spliceAtObjectEnd(lines, /^ {4}},$/, /^ {2}},$/, b.context)
    writeFileSync(path, lines.join("\n"))
    console.log(`  applied ${b.count} key(s) to ${path}`)
  }
}

writeFileSync("/tmp/i18n-merge-blocks.txt", out.join("\n") + "\n")
console.log("\nwrote /tmp/i18n-merge-blocks.txt")
