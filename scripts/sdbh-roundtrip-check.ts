// SDBH round-trip validation against the REAL MARBLE editions (not in repo).
//
//   npx tsx scripts/sdbh-roundtrip-check.ts /path/to/SDBH/Local es
//
// Identity check: extract the <lang> edition's localized strings from its JSON
// and inject them into its own XML — the output must be byte-identical to the
// original XML. This proves the exporter can hand a localization back to the
// MARBLE toolchain without structural loss.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  extractSdbhLocalized,
  injectSdbhXml,
  parseSdbhLexicon,
  type SdbhEntry,
} from "../src/lib/parsers/sdbh"

const [dir, lang = "es"] = process.argv.slice(2)
if (!dir) {
  console.error("usage: tsx scripts/sdbh-roundtrip-check.ts <SDBH/Local dir> [lang]")
  process.exit(2)
}

const jsonPath = join(dir, `SDBH-${lang}.JSON`)
const xmlPath = join(dir, `SDBH-${lang}.XML`)
console.log(`loading ${jsonPath} …`)
const entries = JSON.parse(readFileSync(jsonPath, "utf-8")) as SdbhEntry[]
console.log(`loading ${xmlPath} …`)
const xml = readFileSync(xmlPath, "utf-8")

const parsed = parseSdbhLexicon(entries)
console.log(
  `parsed: ${parsed.entryCount} entries, ${parsed.senseCount} senses, ` +
  `${parsed.files.length} letter files, ${parsed.domainFile.strings.length} domain labels`,
)

const { byCellId } = extractSdbhLocalized(entries)
console.log(`extracted ${byCellId.size} localized strings`)

const t0 = Date.now()
const { xml: injected, sensesInjected, warnings } = injectSdbhXml(xml, { byCellId })
console.log(`injected ${sensesInjected} senses in ${Date.now() - t0}ms, ${warnings.length} warnings`)
for (const w of warnings.slice(0, 5)) console.warn(`  warning: ${w}`)

// The ONE documented normalization: empty <Gloss /> elements (an editor
// artifact — always exactly one per affected sense, up to ~3k in some
// editions) are dropped on import and never re-emitted. Compare against the
// original with the same normalization applied.
const emptyGlossCount = (xml.match(/<Gloss \/>/g) ?? []).length
const expected = xml
  .replace(/<Glosses>(?:\s*<Gloss \/>)+\s*<\/Glosses>/g, "<Glosses />")
  .replace(/\n\s*<Gloss \/>/g, "")
if (emptyGlossCount > 0) console.log(`normalized ${emptyGlossCount} empty <Gloss /> artifacts`)

if (injected === expected) {
  console.log(`✅ IDENTITY ROUND-TRIP OK — byte-identical modulo empty-gloss normalization (${xml.length.toLocaleString()} chars)`)
  process.exit(0)
}
const xmlForDiff = expected

// Locate and report the first divergence with context.
let i = 0
const max = Math.min(xmlForDiff.length, injected.length)
while (i < max && xmlForDiff[i] === injected[i]) i++
console.error(`❌ DIVERGES at char ${i.toLocaleString()} (expected ${xmlForDiff.length.toLocaleString()} vs injected ${injected.length.toLocaleString()})`)
console.error(`--- expected ---\n${JSON.stringify(xmlForDiff.slice(Math.max(0, i - 150), i + 200))}`)
console.error(`--- injected ---\n${JSON.stringify(injected.slice(Math.max(0, i - 150), i + 200))}`)
process.exit(1)
