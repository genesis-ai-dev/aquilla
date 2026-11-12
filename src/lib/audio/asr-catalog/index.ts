// Which languages each hosted transcription model knows (spec §2), and how a
// project's language tag maps onto each model's own codes. The picker uses the
// lists to say "Supports <language>" and to let a person browse them; the
// hosted client uses the mappings to size its audio windows the way the
// server will route them.
//
// Codes are matched through `Intl.getCanonicalLocales`, which folds ISO 639-2/3
// aliases onto their 639-1 code ("ibo" → "ig", "spa" → "es"), so a project
// tagged either way finds the same entry without a hand-kept 639 table.

import { WHISPER_TWO_LETTER, whisperLanguageFromTag } from "../language"

export interface AsrLanguage {
  code: string
  label: string
}

/** Qwen3-ASR's 30 languages (model card, 2026-10-16). */
export const QWEN3_ASR_CODES: readonly string[] = [
  "zh", "en", "yue", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th", "vi", "ja",
  "tr", "hi", "ms", "nl", "sv", "da", "fi", "pl", "cs", "fil", "fa", "el", "hu", "mk", "ro",
]

/**
 * The 22 Chinese dialects Qwen3-ASR recognizes. Display only: OpenRouter has
 * no dialect parameter, so they are transcribed under `zh` / `yue`.
 */
export const QWEN3_ASR_DIALECTS: readonly string[] = [
  "Anhui", "Dongbei", "Fujian", "Gansu", "Guizhou", "Hebei", "Henan", "Hubei", "Hunan",
  "Jiangxi", "Ningxia", "Shandong", "Shaanxi", "Shanxi", "Sichuan", "Tianjin", "Yunnan",
  "Zhejiang", "Cantonese (Hong Kong)", "Cantonese (Guangdong)", "Wu", "Minnan",
]

/** Chinese varieties Qwen3-ASR transcribes under Mandarin (spec §1). */
const QWEN_AS_MANDARIN = new Set(["zh", "cmn", "wuu", "nan", "hak", "gan", "hsn", "cjy", "cpx", "czh", "mnp"])

function canonicalLanguage(subtag: string): string {
  try { return Intl.getCanonicalLocales(subtag)[0]?.toLowerCase() ?? subtag }
  catch { return subtag }
}

function splitTag(tag: string | undefined | null): { language: string; script?: string } | null {
  const parts = tag?.trim().split(/[-_]/).filter(Boolean) ?? []
  const head = parts[0]?.toLowerCase()
  if (!head || !/^[a-z]{2,3}$/.test(head)) return null
  const script = parts.slice(1).find((part) => /^[A-Za-z]{4}$/.test(part))
  return {
    language: canonicalLanguage(head),
    ...(script ? { script: script[0].toUpperCase() + script.slice(1).toLowerCase() } : {}),
  }
}

export function toWhisperCode(tag: string | undefined | null): string | undefined {
  return whisperLanguageFromTag(tag)
}

export function toQwenCode(tag: string | undefined | null): string | undefined {
  const parsed = splitTag(tag)
  if (!parsed) return undefined
  if (QWEN_AS_MANDARIN.has(parsed.language)) return "zh"
  // ICU folds Tagalog's "tgl" onto "tl"; Qwen calls it Filipino.
  const code = parsed.language === "tl" ? "fil" : parsed.language
  return QWEN3_ASR_CODES.includes(code) ? code : undefined
}

/**
 * The upstream `xxx_Script` code for a tag: the tag's script subtag when it
 * has one, otherwise the first upstream code for that language.
 */
export function toOmniCode(tag: string | undefined | null, omniCodes: readonly string[]): string | undefined {
  const parsed = splitTag(tag)
  if (!parsed) return undefined
  const matches = omniCodes.filter((code) => canonicalLanguage(code.split("_")[0]) === parsed.language)
  if (parsed.script) return matches.find((code) => code.split("_")[1] === parsed.script)
  return matches[0]
}

let omniCodes: Promise<readonly string[]> | null = null

/** Upstream `omnilingual_asr/models/wav2vec2_llama/lang_ids.py` (v0.2.0), lazy-loaded. */
export function loadOmnilingualCodes(): Promise<readonly string[]> {
  omniCodes ??= import("./omnilingual.json").then((mod) => mod.default as string[])
  return omniCodes
}

function displayName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code.replace(/_/g, "-")) ?? code
  } catch {
    return code
  }
}

const byLabel = (a: AsrLanguage, b: AsrLanguage) => a.label.localeCompare(b.label)

export function whisperLanguages(locale: string): AsrLanguage[] {
  return [...WHISPER_TWO_LETTER].map((code) => ({ code, label: displayName(code, locale) })).sort(byLabel)
}

export function qwenLanguages(locale: string): AsrLanguage[] {
  return QWEN3_ASR_CODES.map((code) => ({ code, label: displayName(code, locale) })).sort(byLabel)
}

export function omnilingualLanguages(codes: readonly string[], locale: string): AsrLanguage[] {
  return codes.map((code) => ({ code, label: displayName(code, locale) })).sort(byLabel)
}

/**
 * Where the server's automatic routing sends a tag (spec §1), as far as the
 * window size cares: Qwen and Whisper take a minute, Omnilingual 30 s. An
 * empty or unknown tag stays on Whisper's auto-detect.
 */
export function autoRouteIsOpenRouter(tag: string | undefined | null): boolean {
  return !splitTag(tag) || toQwenCode(tag) !== undefined || toWhisperCode(tag) !== undefined
}
