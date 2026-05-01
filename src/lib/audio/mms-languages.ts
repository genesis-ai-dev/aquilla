// Browser-ready MMS-TTS languages. By default this is the small public Xenova
// subset. When VITE_MMS_MODEL_REMOTE_HOST is set, arbitrary MMS codes are
// allowed because the app will load converted ONNX models from our host.

export interface MmsLanguageOption {
  /** MMS / ISO-639-3 code as used in `Xenova/mms-tts-{code}` model ids. */
  code: string
  /** Human-readable name. */
  name: string
}

export const POPULAR_MMS_LANGUAGES: readonly MmsLanguageOption[] = [
  { code: "eng", name: "English" },
  { code: "spa", name: "Spanish" },
  { code: "fra", name: "French" },
  { code: "deu", name: "German" },
  { code: "por", name: "Portuguese" },
  { code: "rus", name: "Russian" },
  { code: "ara", name: "Arabic" },
  { code: "hin", name: "Hindi" },
  { code: "kor", name: "Korean" },
  { code: "ron", name: "Romanian" },
  { code: "vie", name: "Vietnamese" },
  { code: "yor", name: "Yoruba" },
] as const

function cleanTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

export const MMS_MODEL_REMOTE_HOST = cleanTrailingSlash(
  (import.meta.env.VITE_MMS_MODEL_REMOTE_HOST as string | undefined)?.trim() ?? "",
)
export const MMS_MODEL_REMOTE_PATH_TEMPLATE =
  (import.meta.env.VITE_MMS_MODEL_REMOTE_PATH_TEMPLATE as string | undefined)?.trim() ||
  "{model}/resolve/{revision}/"
export const MMS_MODEL_REPO_PREFIX =
  (import.meta.env.VITE_MMS_MODEL_REPO_PREFIX as string | undefined)?.trim() ||
  (MMS_MODEL_REMOTE_HOST ? "facebook/mms-tts-" : "Xenova/mms-tts-")
export const HAS_HOSTED_MMS_MODELS = MMS_MODEL_REMOTE_HOST.length > 0

export const SUPPORTED_MMS_LANGUAGE_CODES = POPULAR_MMS_LANGUAGES.map((l) => l.code)

const SUPPORTED_MMS_LANGUAGE_CODE_SET = new Set(SUPPORTED_MMS_LANGUAGE_CODES)
const MMS_LANGUAGE_CODE_RE = /^[a-z]{3}([-_][a-z0-9]+)?$/i

export function isSupportedMmsLanguageCode(value: string | undefined): boolean {
  if (!value) return false
  const code = value.trim().toLowerCase()
  return SUPPORTED_MMS_LANGUAGE_CODE_SET.has(code) || (HAS_HOSTED_MMS_MODELS && MMS_LANGUAGE_CODE_RE.test(code))
}

export function mmsModelIdForLanguage(value: string): string | null {
  const code = value.trim().toLowerCase()
  return isSupportedMmsLanguageCode(code) ? `${MMS_MODEL_REPO_PREFIX}${code}` : null
}

export function supportedMmsLanguageSummary(): string {
  if (HAS_HOSTED_MMS_MODELS) {
    return "any hosted MMS code in the R2 mirror, such as eng, spa, fra, ita, hun, or yor"
  }
  return POPULAR_MMS_LANGUAGES.map((l) => `${l.name} (${l.code})`).join(", ")
}
