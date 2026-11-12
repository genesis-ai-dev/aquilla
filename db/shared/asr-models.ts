// Hosted transcription model routing and per-model language codes
// (docs/superpowers/specs/2026-10-16-omnilingual-asr.md §1/§2). The client
// sends the project's raw BCP-47 tag; the server picks the model with
// pickAsrModel and maps the tag with toWhisperCode / toQwenCode / toOmniCode.
// Shared by auth-worker (the transcription route) and sync-worker (the Agent
// API tool, which windows audio by the model it will hit).
//
// `toWhisperCode` is a copy of src/lib/audio/language.ts whisperLanguageFromTag
// — the SPA keeps its own for the on-device path.
// auth-worker/src/__tests__/asr-models.test.ts loads the SPA module and asserts
// both agree on every tag, so the copies cannot drift silently.

/** Our model ids (spec table). "auto" is resolved by pickAsrModel. */
export const ASR_MODELS = ["whisper", "qwen3-asr", "omni-ctc", "omni-zs"] as const
export type AsrModel = typeof ASR_MODELS[number]
export const ASR_MODEL_CHOICES = ["auto", ...ASR_MODELS] as const
export type AsrModelChoice = typeof ASR_MODEL_CHOICES[number]

export const isOmniModel = (model: AsrModel): model is "omni-ctc" | "omni-zs" =>
  model === "omni-ctc" || model === "omni-zs"

/** Longest audio one request may carry, per model. Omnilingual rejects 40 s
 *  and up; ZS was trained on ≤30 s clips, so callers window at 30 s. */
export const ASR_WINDOW_SECONDS: Record<AsrModel, number> = {
  "whisper": 60, "qwen3-asr": 60, "omni-ctc": 30, "omni-zs": 30,
}

const WHISPER_TWO_LETTER = new Set<string>([
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca",
  "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms",
  "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la",
  "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
  "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
  "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be",
  "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn",
  "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "ln", "ha", "ba",
  "jw", "su",
])

const THREE_TO_TWO: Record<string, string> = {
  eng: "en", spa: "es", fra: "fr", fre: "fr", deu: "de", ger: "de",
  por: "pt", jpn: "ja", zho: "zh", chi: "zh", hin: "hi", ara: "ar",
  rus: "ru", kor: "ko", ita: "it", nld: "nl", dut: "nl", pol: "pl",
  tur: "tr", swe: "sv", ind: "id", heb: "he", ukr: "uk", ell: "el",
  gre: "el", msa: "ms", may: "ms", ces: "cs", cze: "cs", ron: "ro",
  rum: "ro", dan: "da", hun: "hu", tam: "ta", nor: "no", tha: "th",
  urd: "ur", hrv: "hr", bul: "bg", lit: "lt", lat: "la", mri: "mi",
  mal: "ml", cym: "cy", wel: "cy", slk: "sk", slo: "sk", tel: "te",
  fas: "fa", per: "fa", lav: "lv", ben: "bn", srp: "sr", aze: "az",
  slv: "sl", kan: "kn", est: "et", mkd: "mk", mac: "mk", bre: "br",
  eus: "eu", baq: "eu", isl: "is", ice: "is", hye: "hy", arm: "hy",
  nep: "ne", mon: "mn", bos: "bs", kaz: "kk", sqi: "sq", alb: "sq",
  swa: "sw", glg: "gl", mar: "mr", pan: "pa", sin: "si", khm: "km",
  sna: "sn", yor: "yo", som: "so", afr: "af", oci: "oc", kat: "ka",
  geo: "ka", bel: "be", tgk: "tg", snd: "sd", guj: "gu", amh: "am",
  yid: "yi", lao: "lo", uzb: "uz", fao: "fo", hat: "ht", pus: "ps",
  pus_x: "ps", tuk: "tk", nno: "nn", mlt: "mt", san: "sa", ltz: "lb",
  mya: "my", bur: "my", bod: "bo", tib: "bo", tgl: "tl", mlg: "mg",
  asm: "as", tat: "tt", lin: "ln", hau: "ha", bak: "ba", jav: "jw",
  sun: "su",
}

/** A lane id (8 hex) is not a language; one that leaked through is ignored. */
const LANE_ID_RE = /^[0-9a-f]{8}$/

/** Copy of the SPA's whisperLanguageFromTag — see the header comment. */
export function toWhisperCode(tag: string | undefined | null): string | undefined {
  if (!tag) return undefined
  const norm = tag.trim().toLowerCase()
  if (!norm) return undefined
  if (LANE_ID_RE.test(norm)) return undefined
  const head = norm.split(/[-_]/, 1)[0]
  if (head.length === 2) {
    return WHISPER_TWO_LETTER.has(head) ? head : undefined
  }
  if (head.length === 3) {
    const mapped = THREE_TO_TWO[head]
    return mapped && WHISPER_TWO_LETTER.has(mapped) ? mapped : undefined
  }
  return undefined
}

/** ISO 639-1 → 639-3. Covers Whisper's set plus the 639-1 languages common in
 *  Bible translation that Whisper lacks (the ones Omnilingual is for). */
const TWO_TO_THREE: Record<string, string> = {
  en: "eng", zh: "cmn", de: "deu", es: "spa", ru: "rus", ko: "kor", fr: "fra",
  ja: "jpn", pt: "por", tr: "tur", pl: "pol", ca: "cat", nl: "nld", ar: "arb",
  sv: "swe", it: "ita", id: "ind", hi: "hin", fi: "fin", vi: "vie", he: "heb",
  uk: "ukr", el: "ell", ms: "zsm", cs: "ces", ro: "ron", da: "dan", hu: "hun",
  ta: "tam", no: "nob", th: "tha", ur: "urd", hr: "hrv", bg: "bul", lt: "lit",
  la: "lat", mi: "mri", ml: "mal", cy: "cym", sk: "slk", te: "tel", fa: "pes",
  lv: "lvs", bn: "ben", sr: "srp", az: "azj", sl: "slv", kn: "kan", et: "ekk",
  mk: "mkd", br: "bre", eu: "eus", is: "isl", hy: "hye", ne: "npi", mn: "khk",
  bs: "bos", kk: "kaz", sq: "als", sw: "swh", gl: "glg", mr: "mar", pa: "pan",
  si: "sin", km: "khm", sn: "sna", yo: "yor", so: "som", af: "afr", oc: "oci",
  ka: "kat", be: "bel", tg: "tgk", sd: "snd", gu: "guj", am: "amh", yi: "ydd",
  lo: "lao", uz: "uzn", fo: "fao", ht: "hat", ps: "pbt", tk: "tuk", nn: "nno",
  mt: "mlt", sa: "san", lb: "ltz", my: "mya", bo: "bod", tl: "tgl", mg: "plt",
  as: "asm", tt: "tat", ln: "lin", ha: "hau", ba: "bak", jw: "jav", jv: "jav",
  su: "sun", ig: "ibo", zu: "zul", xh: "xho", rw: "kin", rn: "run", ny: "nya",
  st: "sot", tn: "tsn", ts: "tso", wo: "wol", ff: "ful", om: "gaz", ti: "tir",
  lg: "lug", ak: "aka", ee: "ewe", tw: "twi", ki: "kik", qu: "quy", ay: "ayr",
  gn: "gug", ku: "kmr", ky: "kir", ug: "uig", or: "ory", dv: "div", sm: "smo",
  to: "ton", fj: "fij", ty: "tah", ga: "gle", gd: "gla", co: "cos", eo: "epo",
}

/** 639-2/B (bibliographic) codes that differ from the 639-3 identifier. */
const BIBLIOGRAPHIC_TO_THREE: Record<string, string> = {
  fre: "fra", ger: "deu", chi: "cmn", zho: "cmn", dut: "nld", gre: "ell",
  may: "zsm", msa: "zsm", cze: "ces", rum: "ron", wel: "cym", slo: "slk",
  per: "pes", fas: "pes", mac: "mkd", baq: "eus", ice: "isl", arm: "hye",
  alb: "als", sqi: "als", geo: "kat", bur: "mya", tib: "bod", ara: "arb",
  nor: "nob", swa: "swh", lav: "lvs", est: "ekk", nep: "npi", mon: "khk",
  aze: "azj", uzb: "uzn", pus: "pbt", mlg: "plt", yid: "ydd", orm: "gaz",
  kur: "kmr", que: "quy", aym: "ayr", grn: "gug", ori: "ory", aka: "aka",
}

/** Default script per 639-3 code, used when the tag has no script subtag.
 *  A language missing here gets no `lang` at all (CTC has no language
 *  conditioning anyway), rather than a guessed script. */
const DEFAULT_SCRIPT: Record<string, string> = {
  // Non-Latin scripts.
  cmn: "Hans", yue: "Hant", wuu: "Hans", nan: "Hant", hak: "Hant", jpn: "Jpan", kor: "Hang", rus: "Cyrl", ukr: "Cyrl", bel: "Cyrl",
  bul: "Cyrl", mkd: "Cyrl", srp: "Cyrl", kaz: "Cyrl", kir: "Cyrl", tgk: "Cyrl",
  khk: "Cyrl", tat: "Cyrl", bak: "Cyrl", arb: "Arab", pes: "Arab", urd: "Arab",
  pbt: "Arab", snd: "Arab", uig: "Arab", heb: "Hebr", ydd: "Hebr", ell: "Grek",
  hin: "Deva", mar: "Deva", npi: "Deva", san: "Deva", ben: "Beng", asm: "Beng",
  pan: "Guru", guj: "Gujr", ory: "Orya", tam: "Taml", tel: "Telu", kan: "Knda",
  mal: "Mlym", sin: "Sinh", tha: "Thai", lao: "Laoo", khm: "Khmr", mya: "Mymr",
  bod: "Tibt", kat: "Geor", hye: "Armn", amh: "Ethi", tir: "Ethi", div: "Thaa",
  // Latin script.
  eng: "Latn", deu: "Latn", spa: "Latn", fra: "Latn", por: "Latn", tur: "Latn",
  pol: "Latn", cat: "Latn", nld: "Latn", swe: "Latn", ita: "Latn", ind: "Latn",
  fin: "Latn", vie: "Latn", zsm: "Latn", ces: "Latn", ron: "Latn", dan: "Latn",
  hun: "Latn", nob: "Latn", hrv: "Latn", lit: "Latn", lat: "Latn", mri: "Latn",
  cym: "Latn", slk: "Latn", lvs: "Latn", azj: "Latn", slv: "Latn", ekk: "Latn",
  bre: "Latn", eus: "Latn", isl: "Latn", bos: "Latn", als: "Latn", swh: "Latn",
  glg: "Latn", sna: "Latn", yor: "Latn", som: "Latn", afr: "Latn", oci: "Latn",
  uzn: "Latn", fao: "Latn", hat: "Latn", tuk: "Latn", nno: "Latn", mlt: "Latn",
  ltz: "Latn", tgl: "Latn", plt: "Latn", lin: "Latn", hau: "Latn", jav: "Latn",
  sun: "Latn", ibo: "Latn", zul: "Latn", xho: "Latn", kin: "Latn", run: "Latn",
  nya: "Latn", sot: "Latn", tsn: "Latn", tso: "Latn", wol: "Latn", ful: "Latn",
  gaz: "Latn", lug: "Latn", aka: "Latn", ewe: "Latn", twi: "Latn", kik: "Latn",
  quy: "Latn", ayr: "Latn", gug: "Latn", kmr: "Latn", smo: "Latn", ton: "Latn",
  fij: "Latn", tah: "Latn", gle: "Latn", gla: "Latn", cos: "Latn", epo: "Latn",
  tpi: "Latn", bis: "Latn", pcm: "Latn",
}

/** Map a BCP-47 tag to Omnilingual's `{iso639-3}_{Script}` code, or undefined
 *  when the script cannot be known (the request then goes without `lang`). */
export function toOmniCode(tag: string | undefined | null): string | undefined {
  if (!tag) return undefined
  const norm = tag.trim()
  if (!norm || LANE_ID_RE.test(norm.toLowerCase())) return undefined
  const [rawHead, ...subtags] = norm.split(/[-_]/)
  const head = rawHead.toLowerCase()
  let code: string | undefined
  if (/^[a-z]{2}$/.test(head)) code = TWO_TO_THREE[head]
  else if (/^[a-z]{3}$/.test(head)) code = BIBLIOGRAPHIC_TO_THREE[head] ?? head
  if (!code) return undefined
  const scriptSubtag = subtags.find(s => /^[A-Za-z]{4}$/.test(s))
  const script = scriptSubtag
    ? scriptSubtag[0].toUpperCase() + scriptSubtag.slice(1).toLowerCase()
    : DEFAULT_SCRIPT[code]
  return script ? `${code}_${script}` : undefined
}

/** Chinese varieties (639-3 macro-language members plus zh). Ryder,
 *  2026-10-16: "Keep Whisper as the default for its languages; Qwen only for
 *  Chinese varieties." */
const CHINESE_VARIETIES = new Set<string>([
  "zh", "zho", "chi", "cmn", "yue", "wuu", "nan", "hak", "cdo", "cjy", "cpx",
  "czh", "czo", "gan", "hsn", "mnp", "lzh",
])

function languageHead(tag: string | undefined | null): string | undefined {
  const norm = tag?.trim().toLowerCase()
  if (!norm || LANE_ID_RE.test(norm)) return undefined
  const head = norm.split(/[-_]/, 1)[0]
  return /^[a-z]{2,3}$/.test(head) ? head : undefined
}

/** Qwen3-ASR's language code: Cantonese is its own, every other Chinese
 *  variety is recognised under `zh` (OpenRouter has no dialect parameter). */
export function toQwenCode(tag: string | undefined | null): string | undefined {
  const head = languageHead(tag)
  if (!head || !CHINESE_VARIETIES.has(head)) return undefined
  return head === "yue" ? "yue" : "zh"
}

/** Automatic routing (spec §1). Never picks zero-shot.
 *  1. Chinese variety → qwen3-asr. 2. Whisper language → whisper.
 *  3. Any other language code → omni-ctc (Omnilingual covers 1,600+; CTC needs
 *     no language conditioning, so an unlisted code is still served).
 *  4. No tag, or not a language code (a lane id, `x-private`) → whisper with
 *     auto-detect, today's behaviour. */
export function pickAsrModel(tag: string | undefined | null): "whisper" | "qwen3-asr" | "omni-ctc" {
  const head = languageHead(tag)
  if (!head) return "whisper"
  if (CHINESE_VARIETIES.has(head)) return "qwen3-asr"
  if (toWhisperCode(tag) !== undefined) return "whisper"
  return "omni-ctc"
}
