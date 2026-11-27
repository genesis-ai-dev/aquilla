/**
 * The translating half of the fill job (AQU-2792): turn one locale's
 * `pnpm i18n:todo --new` packet into translations a model wrote, and say which
 * of them may be imported.
 *
 * Everything here is a pure function of the packet, the shipped catalogs and
 * one `complete(messages)` callback, so the rules are tested without a model
 * (i18n-fill.test.ts). `scripts/i18n-fill.ts` is the command around it: it
 * writes the packets, calls the model, imports, and updates the baseline.
 *
 * What a model's answer has to get past before it is imported:
 *
 *   - Placeholders. `interpolate()` leaves an unknown `{name}` in the output
 *     as literal braces, in that locale only. A plain string must keep exactly
 *     the English set; a plural form may drop one (Arabic's "one" form rarely
 *     needs `{count}`) and may not add one. Same rule as
 *     src/lib/i18n/messages/placeholders.test.ts.
 *   - Script. A locale written in another script than Latin must come back in
 *     that script. This is what catches an answer left in English, and Hausa
 *     in Ajami or Punjabi in Shahmukhi.
 *   - A value equal to English is not a translation. The importer drops it, so
 *     it is reported as kept in English; the command records it in the
 *     baseline when the model kept only a few, and fails the locale when it
 *     kept many.
 *
 * A string that fails goes back to the model once with the reason. One that
 * fails twice is left untranslated and listed; the next run tries it again.
 */
import { parseLeafKey } from "../../src/lib/i18n/catalog-export"
import { pluralMessageFor } from "../../src/lib/i18n/context"
import { DEFAULT_LOCALE, LOCALES } from "../../src/lib/i18n/locales"
import { en, type Catalog, type MessageKey } from "../../src/lib/i18n/messages/en"
import { isPluralMessage, type MessageValue } from "../../src/lib/i18n/plurals"

/** One locale's `<locale>.todo.json` and `<locale>.todo.notes.json`. */
export interface Packet {
  locale: string
  /** Leaf → its English, as `pnpm i18n:todo` seeds it. */
  messages: Record<string, string>
  /** Leaf → the translator note `contextNote()` wrote. */
  notes: Record<string, string>
}

export interface ChatMessage {
  role: "system" | "user"
  content: string
}

/** Sends one prompt and returns the model's text. */
export type Complete = (messages: ChatMessage[]) => Promise<string>

export interface FillResult {
  locale: string
  /** Leaf → a translation that passed every check. */
  translated: Record<string, string>
  /** Leaves the model returned exactly as English. */
  kept: string[]
  /** Leaves with no usable answer after the retry, and why. */
  failed: Array<{ leaf: string; issue: string }>
}

/**
 * What each locale's catalog is written in, as the comments in
 * src/lib/i18n/locales.ts and docs/swarm/I18N-TRANSLATION-PROVENANCE.md state
 * it. Only what those two say: a locale with no recorded variety gets its name
 * and script, and the existing translations in the prompt carry the rest.
 */
export const LOCALE_BRIEFS: Record<string, string> = {
  th: "Thai, in Thai script.",
  my: "Burmese, in Burmese script.",
  ms:
    "Malay (Bahasa Melayu), not Indonesian. The interface register is where they differ most: " +
    "muat naik, pratonton, padam, fail, memuat turun.",
  id:
    "Indonesian (Bahasa Indonesia), not Malay. The interface register is where they differ most: " +
    "unggah, pratinjau, hapus, berkas, mengunduh.",
  ar: "Arabic, in Arabic script. The interface is laid out right to left.",
  "zh-Hans": "Simplified Chinese. Translate from the English; do not convert from Traditional Chinese.",
  "zh-Hant": "Traditional Chinese. Translate from the English; do not convert from Simplified Chinese.",
  ru: "Russian.",
  fr: "French.",
  es: "Spanish, worded as neutral Latin American: tú and ustedes, no vosotros, no voseo.",
  pt: "Portuguese, worded as Brazilian: você, arquivo, salvar, tela.",
  sw:
    "Swahili, worded as Kiswahili sanifu, the written East African standard. " +
    "Buttons use the imperative (Hifadhi, Ghairi).",
  hi:
    "Hindi in Devanagari, addressed with the polite form (आप). " +
    "Buttons use the polite imperative (सहेजें, रद्द करें).",
  ha:
    "Hausa, worded as standard written Hausa (Kano, Boko) in Latin script, including ɓ ɗ ƙ. Not Ajami. " +
    "Buttons use the polite plural imperative (ku).",
  ur:
    "Urdu, worded as Modern Standard Urdu: formal آپ, Perso-Arabic script, polite imperative buttons " +
    "(کریں / کیجیے). Not Hindi in Urdu script. The interface is laid out right to left.",
  bn:
    "Bengali, worded as Bangladeshi standard colloquial (প্রমিত চলিত বাংলা): the আপনি imperative, " +
    "পানি not জল.",
  am:
    "Amharic, worded as standard written Amharic (the Addis Ababa standard), in Geʽez script, with the " +
    "formal written imperative.",
  pa: "Punjabi in Gurmukhi (Majhi, the written standard of Indian Punjab). Not Shahmukhi.",
}

/** The script a locale's catalog must be in, where that is not Latin. */
const LOCALE_SCRIPT: Record<string, RegExp> = {
  th: /\p{Script=Thai}/u,
  my: /\p{Script=Myanmar}/u,
  ar: /\p{Script=Arabic}/u,
  ur: /\p{Script=Arabic}/u,
  "zh-Hans": /\p{Script=Han}/u,
  "zh-Hant": /\p{Script=Han}/u,
  ru: /\p{Script=Cyrillic}/u,
  hi: /\p{Script=Devanagari}/u,
  bn: /\p{Script=Bengali}/u,
  am: /\p{Script=Ethiopic}/u,
  pa: /\p{Script=Gurmukhi}/u,
}

/** Strings per request. A request that fails loses this many, no more. */
export const BATCH_SIZE = 40

/**
 * How many strings a locale may come back with unchanged before the answer is
 * not believed: a few product names and formats are expected, a quarter of the
 * packet is a model that did not translate.
 */
export function keptLimit(packetSize: number): number {
  return Math.max(3, Math.floor(packetSize / 4))
}

/**
 * Every `{name}` in a string. Wider than `placeholdersIn` in
 * src/lib/i18n/context.ts, which reads `\w+` names only: a model that
 * translates a name writes `{référence}` or `{数量}`, and those must be seen
 * to be refused.
 */
const placeholdersIn = (text: string): string[] => [...new Set([...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]))]

const withoutPlaceholders = (text: string) => text.replace(/\{[^{}]*\}/g, " ")

/** Every placeholder the English side of `key` can supply, plus its count variable. */
function allowedPlaceholders(key: MessageKey): Set<string> {
  const plural = pluralMessageFor(key)
  if (!plural) return new Set(placeholdersIn(en[key] as string))
  const allowed = new Set<string>([plural.countVar])
  for (const form of Object.values(plural.forms)) {
    if (form !== undefined) for (const name of placeholdersIn(form)) allowed.add(name)
  }
  return allowed
}

/**
 * Why `value` cannot be imported as the translation of `leaf`, or null when it
 * can. `english` is the leaf's seed from the packet.
 */
export function leafIssue(locale: string, leaf: string, english: string, value: string): string | null {
  if (value.trim().length === 0) return "empty"
  const { key, category } = parseLeafKey(leaf)
  if (!Object.prototype.hasOwnProperty.call(en, key)) return "not a message key"
  const allowed = allowedPlaceholders(key as MessageKey)
  const used = new Set(placeholdersIn(value))
  const added = [...used].filter((name) => !allowed.has(name))
  if (added.length > 0) {
    return `uses {${added.join("}, {")}}, which the app does not fill. Allowed: ${[...allowed].map((n) => `{${n}}`).join(", ") || "none"}`
  }
  if (!category) {
    const dropped = placeholdersIn(english).filter((name) => !used.has(name))
    if (dropped.length > 0) return `drops {${dropped.join("}, {")}}`
  }
  const script = LOCALE_SCRIPT[locale]
  if (script && /\p{L}/u.test(withoutPlaceholders(english)) && !script.test(withoutPlaceholders(value))) {
    return `is not written in the script of this language`
  }
  return null
}

const STOP_WORDS = new Set(
  (
    "a an the of for to in on and or is are be with your you this that it its not no yes from by at as " +
    "can could will would has have was were"
  ).split(" "),
)

const wordsOf = (text: string): string[] =>
  withoutPlaceholders(text.toLowerCase())
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))

const flat = (value: MessageValue | undefined): string =>
  value === undefined ? "" : isPluralMessage(value) ? Object.values(value.forms).join(" | ") : value

/** A word in more keys than this is vocabulary (lane, project), not a clue to one screen. */
const COMMON_WORD = 40

let wordIndex: Map<string, MessageKey[]> | undefined

function keysByWord(): Map<string, MessageKey[]> {
  if (wordIndex) return wordIndex
  wordIndex = new Map()
  for (const key of Object.keys(en) as MessageKey[]) {
    for (const word of new Set(wordsOf(flat(en[key])))) {
      wordIndex.set(word, [...(wordIndex.get(word) ?? []), key])
    }
  }
  return wordIndex
}

export interface PriorArt {
  english: string
  translation: string
}

/**
 * Translations this locale already ships that a translator of `leaves` should
 * see, so a new string uses the words the interface already uses:
 *
 *   - for a common word (lane, cell, project), the shortest strings that hold
 *     it, which is the closest thing the catalog has to a glossary entry;
 *   - for a rarer word, the strings that share it;
 *   - the strings beside each key, which are the same screen.
 */
export function priorArt(leaves: string[], catalog: Catalog, limit = 80): PriorArt[] {
  const index = keysByWord()
  const asking = new Set(leaves.map((leaf) => parseLeafKey(leaf).key))
  const usable = (key: MessageKey) => !asking.has(key) && catalog[key] !== undefined
  const picked = new Map<MessageKey, number>()
  const pick = (key: MessageKey, weight: number) => picked.set(key, (picked.get(key) ?? 0) + weight)

  const allKeys = Object.keys(en) as MessageKey[]
  for (const key of asking) {
    if (!Object.prototype.hasOwnProperty.call(en, key)) continue
    const english = flat(en[key as MessageKey])
    for (const word of new Set(wordsOf(english))) {
      const hits = (index.get(word) ?? []).filter(usable)
      if (hits.length === 0) continue
      if ((index.get(word) ?? []).length > COMMON_WORD) {
        const shortest = [...hits].sort((a, b) => flat(en[a]).length - flat(en[b]).length).slice(0, 2)
        for (const hit of shortest) pick(hit, 2)
      } else {
        for (const hit of hits.slice(0, 6)) pick(hit, 1 / hits.length + 1)
      }
    }
    const parent = key.slice(0, key.lastIndexOf(".") + 1)
    if (parent) for (const sibling of allKeys.filter((k) => k.startsWith(parent) && usable(k)).slice(0, 4)) pick(sibling, 1)
  }

  return [...picked]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => ({ english: flat(en[key]), translation: flat(catalog[key]) }))
}

/** The prompt for one batch of one locale's packet. */
export function buildPrompt(
  locale: string,
  batch: Array<{ leaf: string; english: string; note: string; current?: string }>,
  existing: PriorArt[],
  rejected: Record<string, string> = {},
): ChatMessage[] {
  const name = LOCALES.find((entry) => entry.code === locale)?.englishName ?? locale
  const system = [
    `You translate the interface of Aquilla, a web app Bible translation teams work in, from English into ${name} (${locale}).`,
    `What this catalog is written in: ${LOCALE_BRIEFS[locale] ?? name}`,
    "",
    "Rules:",
    "- Translate each string for the place its note describes. A button or menu item is a short command; an error or a hint is a full sentence.",
    `- Use the words the interface already uses. "existing" holds strings from the shipped ${name} interface: reuse their terms, their register and their punctuation.`,
    "- Keep every {placeholder} exactly as written, braces included. Never translate, rename or add one. Move it to where the grammar needs it.",
    "- Keep product names, file formats, file extensions, keyboard keys and URLs as they are.",
    '- A string whose id ends in "#one", "#few", "#other" and so on is one plural form. Write the form its note asks for.',
    '- Where a string has a "current" value, the English under it has changed. Revise that value to match the English, keeping its terms.',
    `- A string that must read exactly the same in ${name} (a product name, a format, a code) is returned unchanged.`,
    "",
    'Answer with one JSON object and nothing else: each id from "strings" mapped to its translation.',
  ].join("\n")

  const strings = batch.map(({ leaf, english, note, current }) => ({
    id: leaf,
    english,
    note,
    ...(current !== undefined ? { current } : {}),
    ...(rejected[leaf] !== undefined ? { rejected: rejected[leaf] } : {}),
  }))
  const user = JSON.stringify(
    {
      ...(Object.keys(rejected).length > 0
        ? { retry: 'Your earlier answer for each of these was not usable; "rejected" says why. Answer again.' }
        : {}),
      existing,
      strings,
    },
    null,
    1,
  )
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

/** The id → text object in a model's answer, however it was wrapped. */
export function parseReply(text: string): Record<string, string> {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [id, value] of Object.entries(parsed)) if (typeof value === "string") out[id] = value
  return out
}

/** The translation with the English's own leading and trailing whitespace. */
function withEnglishEdges(english: string, value: string): string {
  const lead = /^\s*/.exec(english)?.[0] ?? ""
  const trail = /\s*$/.exec(english)?.[0] ?? ""
  return `${lead}${value.trim()}${trail}`
}

/** The value a locale ships for `leaf` today, for a string whose English changed. */
function currentValue(catalog: Catalog, leaf: string): string | undefined {
  const { key, category } = parseLeafKey(leaf)
  const value = catalog[key as MessageKey]
  if (value === undefined) return undefined
  if (!isPluralMessage(value)) return category ? undefined : value
  return category ? value.forms[category] : undefined
}

/**
 * Translate one packet. `catalog` is what the locale ships now: the source of
 * the existing translations in the prompt and of each stale string's current
 * value. A request that throws fails its own batch and no other.
 */
export async function fillPacket(packet: Packet, catalog: Catalog, complete: Complete): Promise<FillResult> {
  const { locale } = packet
  const result: FillResult = { locale, translated: {}, kept: [], failed: [] }
  if (locale === DEFAULT_LOCALE || LOCALE_BRIEFS[locale] === undefined) {
    throw new Error(`no translation brief for locale "${locale}": add it to LOCALE_BRIEFS in scripts/lib/i18n-fill.ts`)
  }
  const leaves = Object.keys(packet.messages)

  for (let at = 0; at < leaves.length; at += BATCH_SIZE) {
    const batch = leaves.slice(at, at + BATCH_SIZE).map((leaf) => ({
      leaf,
      english: packet.messages[leaf],
      note: packet.notes[leaf] ?? "",
      current: currentValue(catalog, leaf),
    }))
    const existing = priorArt(
      batch.map((entry) => entry.leaf),
      catalog,
    )
    let pending = batch
    let rejected: Record<string, string> = {}
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      let reply: Record<string, string>
      try {
        reply = parseReply(await complete(buildPrompt(locale, pending, existing, rejected)))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        rejected = Object.fromEntries(pending.map(({ leaf }) => [leaf, `the request failed: ${reason}`]))
        continue
      }
      const next: typeof pending = []
      rejected = {}
      for (const entry of pending) {
        const answer = reply[entry.leaf]
        if (answer === undefined) {
          rejected[entry.leaf] = "no answer for this id"
          next.push(entry)
          continue
        }
        const value = withEnglishEdges(entry.english, answer)
        if (value === entry.english) {
          result.kept.push(entry.leaf)
          continue
        }
        const issue = leafIssue(locale, entry.leaf, entry.english, value)
        if (issue === null) result.translated[entry.leaf] = value
        else {
          rejected[entry.leaf] = issue
          next.push(entry)
        }
      }
      pending = next
    }
    for (const { leaf } of pending) result.failed.push({ leaf, issue: rejected[leaf] ?? "no usable answer" })
  }

  // A model that hands back a quarter of a packet unchanged did not translate
  // it. Those strings are failures to retry, not strings to keep in English.
  if (result.kept.length > keptLimit(leaves.length)) {
    for (const leaf of result.kept) result.failed.push({ leaf, issue: "returned unchanged, with too many others" })
    result.kept = []
  }
  return result
}

/**
 * The message keys of `result.kept` whose every leaf in the packet was kept:
 * the ones to record as deliberately English. A plural key with one form kept
 * and another translated is a translation, not a key kept in English.
 */
export function keptKeys(packet: Packet, result: FillResult): string[] {
  const kept = new Set(result.kept)
  const byKey = new Map<string, string[]>()
  for (const leaf of Object.keys(packet.messages)) {
    const { key } = parseLeafKey(leaf)
    byKey.set(key, [...(byKey.get(key) ?? []), leaf])
  }
  return [...byKey].filter(([, keyLeaves]) => keyLeaves.every((leaf) => kept.has(leaf))).map(([key]) => key)
}
