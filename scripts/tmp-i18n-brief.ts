/**
 * Temporary helper: build a translator brief for every key still missing from a
 * locale — the English source, its resolved context, and prior art from keys
 * that already share distinctive vocabulary in that same locale.
 *
 * Usage: npx tsx scripts/tmp-i18n-brief.ts [locale…]   (default: th my ms ar)
 */
import { writeFileSync } from "node:fs"
import { en, type MessageKey } from "../src/lib/i18n/messages/en"
import { CATALOGS } from "../src/lib/i18n/messages/index"
import { isPluralMessage, type MessageValue } from "../src/lib/i18n/plurals"
import { resolveKeyContext } from "../src/lib/i18n/context"

const locales = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["th", "my", "ms", "ar"]

const flat = (v: MessageValue | undefined): string =>
  v === undefined ? "" : isPluralMessage(v) ? Object.values(v.forms).join(" | ") : v

const STOP = new Set(
  ("a an the of for for to in on and or is are be with your you this that it its" +
    " not no yes from by at as can could will would has have was were").split(/\s+/),
)
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\{[^}]*\}/g, " ")
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2 && !STOP.has(w))

const enKeys = Object.keys(en) as MessageKey[]
const index = new Map<string, MessageKey[]>()
for (const k of enKeys) {
  for (const w of new Set(words(flat(en[k])))) {
    index.set(w, [...(index.get(w) ?? []), k])
  }
}

const out: string[] = []
for (const locale of locales) {
  const cat = CATALOGS[locale] as Record<string, MessageValue>
  const missing = enKeys.filter((k) => !(k in cat))
  out.push(`\n\n${"=".repeat(78)}\nLOCALE ${locale} — ${missing.length} missing key(s)\n${"=".repeat(78)}`)
  for (const k of missing) {
    const src = flat(en[k])
    const ctx = resolveKeyContext(k)
    out.push(`\n--- ${k}`)
    out.push(`EN: ${JSON.stringify(en[k])}`)
    out.push(`WHAT: ${ctx.description.replace(/\s+/g, " ")}`)
    if (ctx.maxLength !== undefined) out.push(`MAXLEN: ${ctx.maxLength}`)
    if (Object.keys(ctx.placeholders).length) out.push(`PLACEHOLDERS: ${JSON.stringify(ctx.placeholders)}`)
    const cands = new Map<MessageKey, number>()
    for (const w of new Set(words(src))) {
      const hits = index.get(w) ?? []
      if (hits.length > 40) continue
      for (const h of hits) {
        if (h === k || !(h in cat)) continue
        cands.set(h, (cands.get(h) ?? 0) + 1 / hits.length)
      }
    }
    const top = [...cands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    if (top.length === 0) out.push("PRIOR ART: (none)")
    for (const [h] of top) {
      out.push(`PRIOR ${h}\n   en: ${JSON.stringify(flat(en[h]))}\n   ${locale}: ${JSON.stringify(flat(cat[h]))}`)
    }
  }
}
writeFileSync("/tmp/i18n-translate-brief.txt", out.join("\n") + "\n")
console.log(`wrote /tmp/i18n-translate-brief.txt for ${locales.join(", ")}`)
